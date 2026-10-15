// Transfer jobs over the database: load a patient's primary rows, run the pure plan, persist the EXPORT-stage
// issues, the job outcome and one EXPORT audit entry. Synchronous (D): the caller waits for the finished job.
import type { Db } from "@/db";
import { recordAudit } from "@/audit";
import type { CanonicalResource, CanonicalType } from "@/canonical";
import { MAPPING_VERSION } from "@/mapping/map-resource";
import { replaceIssues } from "@/mapping/run";
import { renderFidelityReport, summarize, type OpenIssueCount } from "@/export/report";
import { sealAtRest } from "@/security/at-rest";
import { planTransfer, type ExportRow } from "@/export/transfer";
import { TARGET_PROFILE } from "@/export/us-core";

const SOURCE_SELECT = { select: { format: true, sourceSystem: true, sha256: true } } as const;

/** The patient's primary rows (duplicate_of_id is null) with their linked duplicates. */
export async function loadExportRows(
  db: Pick<Db, "canonicalResource">,
  patientId: string,
): Promise<{ rows: (ExportRow & { sourceRecordId: string })[]; stale: number }> {
  const stale = await db.canonicalResource.count({
    where: {
      patientId,
      OR: [{ mappingVersion: null }, { mappingVersion: { not: MAPPING_VERSION } }],
    },
  });
  const primaries = await db.canonicalResource.findMany({
    where: { patientId, duplicateOfId: null },
    select: {
      id: true,
      sourceRecordId: true,
      resourceType: true,
      fhirId: true,
      resource: true,
      mapped: true,
      sourceRecord: SOURCE_SELECT,
      duplicates: {
        select: { resourceType: true, fhirId: true, resource: true, sourceRecord: SOURCE_SELECT },
      },
    },
  });
  const rows = primaries.map((p) => ({
    rowId: p.id,
    sourceRecordId: p.sourceRecordId,
    resourceType: p.resourceType as CanonicalType,
    fhirId: p.fhirId,
    resource: p.resource as CanonicalResource,
    mapped: p.mapped as CanonicalResource,
    source: p.sourceRecord,
    duplicates: p.duplicates
      .map((d) => ({
        resourceType: d.resourceType,
        fhirId: d.fhirId,
        resource: d.resource as CanonicalResource,
        source: d.sourceRecord,
      }))
      .sort((a, b) => (a.source.format + a.fhirId < b.source.format + b.fhirId ? -1 : 1)),
  }));
  return { rows, stale };
}

export type TransferRunResult = {
  jobId: string;
  status: "SUCCEEDED" | "FAILED";
  dryRun: boolean;
  patient: { id: string; sourceSystem: string; sourcePatientId: string };
  exportedAt: string;
  resourcesSelected: number | null;
  resourcesExported: number | null;
  resourcesExcluded: number | null;
  completeness: number | null;
  bundleSha256: string | null;
  /** The serialized bundle; null for a dry run or a failed job. */
  bundleText: string | null;
  report: string | null;
  error: string | null;
};

export class PatientNotFoundError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves a source Patient.id or an internal patient id to the internal id. */
export async function resolvePatient(db: Pick<Db, "patient">, ref: string): Promise<string> {
  let matches = await db.patient.findMany({
    where: { sourcePatientId: ref },
    select: { id: true },
    take: 2,
  });
  if (!matches.length && UUID.test(ref))
    matches = await db.patient.findMany({ where: { id: ref }, select: { id: true } });
  if (matches.length > 1)
    throw new PatientNotFoundError(
      "source Patient.id matches several patients; pass the internal id",
    );
  if (!matches.length) throw new PatientNotFoundError("patient not found");
  return matches[0]!.id;
}

/** A job as the API returns it: status, counts and the report, never the bundle. */
export const JOB_VIEW = {
  id: true,
  patientId: true,
  status: true,
  dryRun: true,
  targetProfile: true,
  requestedBy: true,
  createdAt: true,
  finishedAt: true,
  exportedAt: true,
  resourcesSelected: true,
  resourcesExported: true,
  resourcesExcluded: true,
  completeness: true,
  bundleSha256: true,
  bundleBytes: true,
  error: true,
  report: true,
  patient: { select: { sourceSystem: true, sourcePatientId: true } },
} as const;

/**
 * Runs one transfer job for a patient (internal id). A dry run stores the job, issues, report and bundle hash but
 * not the bundle. Failures are recorded on the job (FAILED, reason without PHI) and returned, not thrown.
 */
export async function runTransfer(
  db: Db,
  {
    patientId,
    dryRun = false,
    actor,
    exportedAt = new Date(),
  }: { patientId: string; dryRun?: boolean; actor: string; exportedAt?: Date },
): Promise<TransferRunResult> {
  const patient = await db.patient.findUnique({
    where: { id: patientId },
    select: { id: true, sourceSystem: true, sourcePatientId: true },
  });
  if (!patient) throw new PatientNotFoundError("patient not found");
  const at = exportedAt.toISOString();
  const job = await db.transferJob.create({
    data: {
      patientId,
      dryRun,
      targetProfile: TARGET_PROFILE,
      requestedBy: actor,
      status: "RUNNING",
      startedAt: new Date(),
      exportedAt,
    },
  });
  const result: TransferRunResult = {
    jobId: job.id,
    status: "FAILED",
    dryRun,
    patient,
    exportedAt: at,
    resourcesSelected: null,
    resourcesExported: null,
    resourcesExcluded: null,
    completeness: null,
    bundleSha256: null,
    bundleText: null,
    report: null,
    error: null,
  };
  const audit = (tx: Parameters<typeof recordAudit>[0]) =>
    recordAudit(tx, {
      actor,
      action: "EXPORT",
      patientId,
      entityType: "TransferJob",
      entityId: job.id,
      source: "transfer",
      details: {
        dryRun,
        status: result.status,
        targetProfile: TARGET_PROFILE,
        selected: result.resourcesSelected,
        exported: result.resourcesExported,
        excluded: result.resourcesExcluded,
        completeness: result.completeness === null ? null : Number(result.completeness.toFixed(4)),
        bundleSha256: result.bundleSha256,
      },
    });

  try {
    const { rows, stale } = await loadExportRows(db, patientId);
    if (stale)
      throw new Error(
        `${stale} canonical rows are not mapped at ${MAPPING_VERSION}; run pnpm map first`,
      );
    const plan = planTransfer(rows, at);
    const grouped = await db.mappingIssue.groupBy({
      by: ["stage", "severity", "code"],
      where: { patientId, status: "OPEN", stage: { not: "EXPORT" } },
      _count: { _all: true },
    });
    const openIssues: OpenIssueCount[] = grouped
      .map((g) => ({ stage: g.stage, severity: g.severity, code: g.code, count: g._count._all }))
      .sort((a, b) => (a.stage + a.severity + a.code < b.stage + b.severity + b.code ? -1 : 1));
    const { overall, byType } = summarize(plan);
    Object.assign(result, {
      status: !dryRun && plan.blockers.length ? "FAILED" : "SUCCEEDED",
      resourcesSelected: overall.selected,
      resourcesExported: overall.exported,
      resourcesExcluded: overall.excluded,
      completeness: overall.completeness,
      bundleSha256: plan.bundleSha256,
      bundleText: dryRun ? null : plan.bundleText,
      report: renderFidelityReport({ plan, dryRun, patient, openIssues }),
      error: !dryRun && plan.blockers.length ? plan.blockers.join("; ") : null,
    });
    const sourceRecordIds = new Map(rows.map((r) => [r.rowId, r.sourceRecordId]));
    await db.$transaction(
      async (tx) => {
        await replaceIssues(
          tx,
          patientId,
          "EXPORT",
          rows.map((r) => r.rowId),
          plan.issues.map(({ rowId, ...i }) => ({
            ...i,
            canonicalResourceId: rowId,
            sourceRecordId: sourceRecordIds.get(rowId)!,
          })),
        );
        await tx.transferJob.update({
          where: { id: job.id },
          data: {
            status: result.status,
            finishedAt: new Date(),
            resourcesSelected: result.resourcesSelected,
            resourcesExported: result.resourcesExported,
            resourcesExcluded: result.resourcesExcluded,
            completeness: result.completeness,
            summary: {
              overall,
              byType,
              provenance: plan.provenanceCount,
              blockers: plan.blockers.length,
            },
            report: result.report,
            bundle: result.bundleText ? sealAtRest(result.bundleText) : null,
            bundleSha256: result.bundleSha256,
            bundleBytes: result.bundleText ? Buffer.byteLength(result.bundleText) : null,
            error: result.error,
          },
        });
        await audit(tx);
      },
      { timeout: 120_000 },
    );
  } catch (err) {
    // Messages from this pipeline carry types, paths and counts only; cap length in case a driver adds more.
    Object.assign(result, {
      status: "FAILED",
      bundleText: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
    await db.transferJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: result.error },
    });
    await audit(db);
  }
  return result;
}
