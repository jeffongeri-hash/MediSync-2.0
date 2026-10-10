// The mapping pass over stored canonical rows: map (terminology, units, provenance), then dedupe per patient.
// Idempotent: only patients with rows at another mapping version are touched, and each stage replaces only its
// own OPEN issues, so issues a reviewer resolved or ignored are kept and not raised again.
import type { Db } from "@/db";
import type { Prisma } from "@/generated/prisma/client";
import { recordAudit } from "@/audit";
import type { CanonicalResource, IngestIssue } from "@/canonical";
import { dedupePatient, FORMAT_RANK, type DedupeRow } from "@/mapping/dedupe";
import { MAPPING_VERSION, mapResource } from "@/mapping/map-resource";
import { localTerminology, type TerminologySource } from "@/mapping/terminology";

export type MappingRunResult = { patients: number; mapped: number; duplicatesLinked: number; issues: number };
type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
type Stage = "MAPPING" | "DEDUPE";
type PendingIssue = IngestIssue & { canonicalResourceId: string; sourceRecordId: string };

export async function runMapping(
  db: Db,
  { actor = "system:mapping", all = false, terminology = localTerminology }: { actor?: string; all?: boolean; terminology?: TerminologySource } = {},
): Promise<MappingRunResult> {
  const stale = await db.canonicalResource.findMany({
    where: all ? {} : { OR: [{ mappingVersion: null }, { mappingVersion: { not: MAPPING_VERSION } }] },
    distinct: ["patientId"],
    select: { patientId: true },
  });
  const result: MappingRunResult = { patients: 0, mapped: 0, duplicatesLinked: 0, issues: 0 };
  for (const { patientId } of stale) {
    await db.$transaction((tx) => mapPatient(tx, patientId, { actor, all, terminology }, result), { timeout: 120_000 });
    result.patients++;
  }
  return result;
}

async function mapPatient(tx: Tx, patientId: string, opts: { actor: string; all: boolean; terminology: TerminologySource }, result: MappingRunResult) {
  const rows = await tx.canonicalResource.findMany({
    where: { patientId },
    select: {
      id: true,
      resourceType: true,
      fhirId: true,
      resource: true,
      sourceRecordId: true,
      mappingVersion: true,
      codeSystem: true,
      code: true,
      sourceDate: true,
      dedupeKey: true,
      duplicateOfId: true,
      sourceRecord: { select: { format: true, sourceSystem: true } },
    },
  });
  rows.sort((a, b) => FORMAT_RANK[a.sourceRecord.format] - FORMAT_RANK[b.sourceRecord.format]);
  const medications = new Map<string, CanonicalResource>();
  for (const r of rows) {
    const key = `Medication/${r.fhirId}`;
    if (r.resourceType === "Medication" && !medications.has(key)) medications.set(key, r.resource as CanonicalResource);
  }

  // 1. Map rows at another version.
  const toMap = rows.filter((r) => opts.all || r.mappingVersion !== MAPPING_VERSION);
  const mappingIssues: PendingIssue[] = [];
  for (const r of toMap) {
    const m = mapResource(r.resource as CanonicalResource, {
      sourceRecordId: r.sourceRecordId,
      sourceSystem: r.sourceRecord.sourceSystem,
      terminology: opts.terminology,
      medications,
    });
    await tx.canonicalResource.update({
      where: { id: r.id },
      data: {
        mapped: m.mapped as Prisma.InputJsonValue,
        mappingVersion: MAPPING_VERSION,
        mappingStatus: m.status,
        codeSystem: m.primary?.system ?? null,
        code: m.primary?.code ?? null,
        sourceSystem: r.sourceRecord.sourceSystem,
        sourceDate: m.sourceDate ? new Date(m.sourceDate) : null,
      },
    });
    Object.assign(r, { codeSystem: m.primary?.system ?? null, code: m.primary?.code ?? null, sourceDate: m.sourceDate ? new Date(m.sourceDate) : null });
    mappingIssues.push(...m.issues.map((i) => ({ ...i, canonicalResourceId: r.id, sourceRecordId: r.sourceRecordId })));
  }
  result.mapped += toMap.length;
  await replaceIssues(tx, patientId, "MAPPING", toMap.map((r) => r.id), mappingIssues);

  // 2. Dedupe the whole patient (new rows can link to old ones).
  const dedupeRows: DedupeRow[] = rows.map((r) => ({
    id: r.id,
    resourceType: r.resourceType,
    fhirId: r.fhirId,
    sourceRecordId: r.sourceRecordId,
    sourceSystem: r.sourceRecord.sourceSystem,
    format: r.sourceRecord.format,
    codeSystem: r.codeSystem,
    code: r.code,
    sourceDate: r.sourceDate?.toISOString() ?? null,
  }));
  const { links, issues } = dedupePatient(dedupeRows);
  const current = new Map(rows.map((r) => [r.id, r]));
  for (const l of links) {
    const r = current.get(l.id)!;
    if (r.dedupeKey !== l.dedupeKey || r.duplicateOfId !== l.duplicateOfId) {
      await tx.canonicalResource.update({ where: { id: l.id }, data: { dedupeKey: l.dedupeKey, duplicateOfId: l.duplicateOfId } });
    }
  }
  const dedupeIssues = issues.map(({ rowId, ...i }) => ({ ...i, canonicalResourceId: rowId, sourceRecordId: current.get(rowId)!.sourceRecordId }));
  await replaceIssues(tx, patientId, "DEDUPE", rows.map((r) => r.id), dedupeIssues);
  const linked = links.filter((l) => l.duplicateOfId).length;
  result.duplicatesLinked += linked;
  result.issues += mappingIssues.length + dedupeIssues.length;

  await recordAudit(tx, {
    actor: opts.actor,
    action: "UPDATE",
    patientId,
    entityType: "CanonicalResource",
    entityId: patientId,
    source: "mapping",
    details: { mappingVersion: MAPPING_VERSION, mapped: toMap.length, duplicatesLinked: linked },
  });
}

/** Replaces a stage's OPEN issues on the given rows; an issue already RESOLVED or IGNORED is not raised again. */
async function replaceIssues(tx: Tx, patientId: string, stage: Stage, rowIds: string[], issues: PendingIssue[]) {
  if (!rowIds.length) return;
  await tx.mappingIssue.deleteMany({ where: { stage, status: "OPEN", canonicalResourceId: { in: rowIds } } });
  const closed = await tx.mappingIssue.findMany({
    where: { stage, status: { not: "OPEN" }, canonicalResourceId: { in: rowIds } },
    select: { canonicalResourceId: true, code: true, path: true, message: true },
  });
  const sig = (i: { canonicalResourceId: string | null; code: string; path?: string | null; message: string }) =>
    `${i.canonicalResourceId}\u0000${i.code}\u0000${i.path ?? ""}\u0000${i.message}`;
  const done = new Set(closed.map(sig));
  await tx.mappingIssue.createMany({
    data: issues
      .filter((i) => !done.has(sig(i)))
      .map((i) => ({
        patientId,
        sourceRecordId: i.sourceRecordId,
        canonicalResourceId: i.canonicalResourceId,
        stage,
        severity: i.severity,
        code: i.code,
        message: i.message,
        path: i.path ?? null,
        details: { ...i.details, resourceType: i.resourceType ?? null, fhirId: i.fhirId ?? null },
      })),
  });
}
