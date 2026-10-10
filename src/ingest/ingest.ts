import { randomUUID } from "node:crypto";
import type { Db } from "@/db";
import type { Prisma } from "@/generated/prisma/client";
import type { SourceFormat } from "@/generated/prisma/enums";
import { recordAudit, type AuditEntry } from "@/audit";
import { aggregateInfo, issue, type IngestIssue, type IssueSeverity } from "@/canonical";
import { parseCcda } from "@/ingest/parse-ccda";
import { parseFhirBundle, parseNdjson, type ParsedResource, type ParseResult } from "@/ingest/parse-fhir";
import type { ReferenceIndex } from "@/ingest/references";
import { sha256 } from "@/ingest/source-summary";

/** Bump when parser output changes in a way that matters for already-parsed sources. */
export const PARSER_VERSION = "phase1.1";

export type SourceInput = {
  format: SourceFormat;
  sourceSystem: string;
  filename: string;
  bytes: Buffer;
  contentType: string;
  sourceRecordId?: string | null;
  summary?: object;
  /** Resolves references into other sources (FHIR bundles only). */
  refIndex?: ReferenceIndex;
};

export type IngestOutcome = {
  sourceRecordId: string;
  created: boolean;
  parsed: boolean;
  patientsCreated: number;
  canonicalCount: number;
  issueCounts: Record<IssueSeverity, number>;
};

export function parseSource(format: SourceFormat, rawText: string, refIndex?: ReferenceIndex): ParseResult {
  if (format === "FHIR_BUNDLE") return parseFhirBundle(rawText, refIndex);
  if (format === "FHIR_NDJSON") return parseNdjson(rawText, refIndex);
  return parseCcda(rawText);
}

function displayName(p: Record<string, unknown>): string | null {
  const names = (p.name ?? []) as { use?: string; given?: string[]; family?: string }[];
  const n = names.find((x) => x.use === "official") ?? names[0];
  return n ? [...(n.given ?? []), n.family].filter(Boolean).join(" ") || null : null;
}

/**
 * Stores a source untouched, then its canonical resources and issues, in one transaction with audit entries.
 * Idempotent: a source already parsed (same sha256) is skipped; one stored but never parsed is parsed now.
 */
export async function ingestSource(db: Db, input: SourceInput, actor: string): Promise<IngestOutcome> {
  const hash = sha256(input.bytes);
  const existing = await db.sourceRecord.findUnique({ where: { sha256: hash }, select: { id: true, parsedAt: true } });
  const outcome: IngestOutcome = {
    sourceRecordId: existing?.id ?? "",
    created: !existing,
    parsed: false,
    patientsCreated: 0,
    canonicalCount: 0,
    issueCounts: { INFO: 0, WARNING: 0, ERROR: 0 },
  };
  if (existing?.parsedAt) return outcome;

  const rawText = input.bytes.toString("utf8");
  const parsed = parseSource(input.format, rawText, input.refIndex);

  await db.$transaction(
    async (tx) => {
      const audit: AuditEntry[] = [];
      const source = { source: input.sourceSystem };
      const record =
        existing ??
        (await tx.sourceRecord.create({
          data: {
            format: input.format,
            sourceSystem: input.sourceSystem,
            sourceRecordId: input.sourceRecordId ?? null,
            filename: input.filename,
            contentType: input.contentType,
            rawText,
            sha256: hash,
            byteSize: input.bytes.length,
            summary: (input.summary ?? {}) as Prisma.InputJsonValue,
          },
          select: { id: true },
        }));
      outcome.sourceRecordId = record.id;
      if (!existing) {
        audit.push({ actor, action: "CREATE", entityType: "SourceRecord", entityId: record.id, source: input.sourceSystem, details: { format: input.format, byteSize: input.bytes.length } });
      }

      // Patient index: one row per (source system, Patient.id), created from the canonical Patient.
      const patientIds = new Map<string, string>();
      for (const { resource: p } of parsed.resources.filter((r) => r.resource.resourceType === "Patient")) {
        const key = { sourceSystem: input.sourceSystem, sourcePatientId: p.id };
        const found = await tx.patient.findUnique({ where: { sourceSystem_sourcePatientId: key }, select: { id: true } });
        if (found) {
          patientIds.set(p.id, found.id);
          continue;
        }
        const pr = p as Record<string, unknown>;
        const created = await tx.patient.create({
          data: {
            ...key,
            displayName: displayName(pr),
            birthDate: typeof pr.birthDate === "string" && pr.birthDate.length === 10 ? new Date(pr.birthDate) : null,
            gender: typeof pr.gender === "string" ? pr.gender : null,
          },
          select: { id: true },
        });
        patientIds.set(p.id, created.id);
        outcome.patientsCreated++;
        audit.push({ actor, action: "CREATE", patientId: created.id, entityType: "Patient", entityId: created.id, ...source });
      }
      const referenced = [...new Set(parsed.resources.flatMap((r) => r.sourcePatientId ?? []))].filter((id) => !patientIds.has(id));
      if (referenced.length) {
        const rows = await tx.patient.findMany({
          where: { sourceSystem: input.sourceSystem, sourcePatientId: { in: referenced } },
          select: { id: true, sourcePatientId: true },
        });
        for (const r of rows) patientIds.set(r.sourcePatientId, r.id);
      }

      // Attribute, de-duplicate, and assign ids so issues can point at their canonical row.
      const issues: IngestIssue[] = [...parsed.issues];
      const rows: (ParsedResource & { id: string; patientId: string })[] = [];
      const seen = new Map<string, string>();
      const firstByKey = new Map<string, unknown>();
      for (const r of parsed.resources) {
        const { resourceType, id: fhirId } = r.resource;
        const key = `${resourceType}/${fhirId}`;
        const patientId = r.sourcePatientId ? patientIds.get(r.sourcePatientId) : undefined;
        if (seen.has(key)) {
          const same = JSON.stringify(firstByKey.get(key)) === JSON.stringify(r.resource);
          issues.push(
            same
              ? issue("INFO", "duplicate_in_source", `${resourceType} repeated with identical content; collapsed`, { path: r.sourcePath, resourceType })
              : issue("WARNING", "duplicate_in_source", `${resourceType} id repeated with different content; first kept`, { path: r.sourcePath, resourceType, fhirId }),
          );
        } else if (!patientId) {
          issues.push(issue("WARNING", "unknown_patient", `${resourceType} is not attributable to a known patient; not stored as canonical`, { path: r.sourcePath, resourceType, fhirId }));
        } else {
          const id = randomUUID();
          seen.set(key, id);
          firstByKey.set(key, r.resource);
          rows.push({ ...r, id, patientId });
        }
      }
      const patientByKey = new Map(rows.map((r) => [`${r.resource.resourceType}/${r.resource.id}`, r.patientId]));

      await tx.canonicalResource.createMany({
        data: rows.map((r) => ({
          id: r.id,
          patientId: r.patientId,
          sourceRecordId: record.id,
          resourceType: r.resource.resourceType,
          fhirId: r.resource.id,
          resource: r.resource as Prisma.InputJsonValue,
          sourcePath: r.sourcePath,
        })),
      });

      const finalIssues = aggregateInfo(issues);
      const singlePatient = new Set(rows.map((r) => r.patientId)).size === 1 ? rows[0]!.patientId : null;
      await tx.mappingIssue.createMany({
        data: finalIssues.map((i) => {
          const key = i.resourceType && i.fhirId ? `${i.resourceType}/${i.fhirId}` : "";
          return {
            patientId: patientByKey.get(key) ?? singlePatient,
            sourceRecordId: record.id,
            canonicalResourceId: seen.get(key) ?? null,
            severity: i.severity,
            code: i.code,
            message: i.message,
            path: i.path ?? null,
            details: { ...i.details, resourceType: i.resourceType ?? null, fhirId: i.fhirId ?? null },
          };
        }),
      });

      await tx.sourceRecord.update({
        where: { id: record.id },
        data: { patientId: singlePatient, parsedAt: new Date(), parserVersion: PARSER_VERSION },
      });

      // One audit entry per patient whose chart data this source wrote (ids and counts only).
      const perPatient = new Map<string, number>();
      for (const r of rows) perPatient.set(r.patientId, (perPatient.get(r.patientId) ?? 0) + 1);
      for (const [patientId, count] of perPatient) {
        audit.push({ actor, action: "CREATE", patientId, entityType: "CanonicalResource", entityId: record.id, ...source, details: { format: input.format, count } });
      }
      await recordAudit(tx, audit);

      outcome.parsed = true;
      outcome.canonicalCount = rows.length;
      for (const i of finalIssues) outcome.issueCounts[i.severity]++;
    },
    { timeout: 60_000 },
  );
  return outcome;
}
