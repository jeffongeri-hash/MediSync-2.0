import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@/db";
import type { Prisma } from "@/generated/prisma/client";
import { recordAudit, type AuditEntry } from "@/audit";
import {
  sha256,
  summarizeCcda,
  summarizeFhirBundle,
  syntheaPatientIdFromFilename,
} from "@/ingest/source-summary";

export const SYNTHEA_SOURCE = "synthea";

export type SeedResult = {
  patientsCreated: number;
  sourceRecordsCreated: number;
  sourceRecordsSkipped: number;
};

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(ext)).sort();
}

/**
 * Loads Synthea output (fhir/*.json, ccda/*.xml) as untouched source records plus a patient index.
 * Idempotent: files are keyed by sha256, patients by (source system, Patient.id).
 */
export async function seedSynthea(db: Db, dir: string, actor = "system:seed"): Promise<SeedResult> {
  const result: SeedResult = { patientsCreated: 0, sourceRecordsCreated: 0, sourceRecordsSkipped: 0 };

  // FHIR first so C-CDA documents can attach to the patients they describe.
  for (const filename of await listFiles(join(dir, "fhir"), ".json")) {
    const bytes = await readFile(join(dir, "fhir", filename));
    const rawText = bytes.toString("utf8");
    const summary = summarizeFhirBundle(rawText);
    await ingestFile(db, result, actor, {
      filename,
      bytes,
      rawText,
      format: "FHIR_BUNDLE",
      contentType: "application/fhir+json",
      sourceRecordId: summary.bundleId,
      summary,
      patient: summary.patient,
    });
  }

  for (const filename of await listFiles(join(dir, "ccda"), ".xml")) {
    const bytes = await readFile(join(dir, "ccda", filename));
    const rawText = bytes.toString("utf8");
    const patientUuid = syntheaPatientIdFromFilename(filename);
    await ingestFile(db, result, actor, {
      filename,
      bytes,
      rawText,
      format: "CCDA",
      contentType: "application/xml",
      sourceRecordId: null,
      summary: summarizeCcda(rawText),
      patient: patientUuid ? { id: patientUuid } : null,
    });
  }

  return result;
}

type FileInput = {
  filename: string;
  bytes: Buffer;
  rawText: string;
  format: "FHIR_BUNDLE" | "CCDA";
  contentType: string;
  sourceRecordId: string | null;
  summary: object;
  patient: { id: string; displayName?: string | null; birthDate?: string | null; gender?: string | null } | null;
};

async function ingestFile(db: Db, result: SeedResult, actor: string, input: FileInput): Promise<void> {
  const hash = sha256(input.bytes);
  if (await db.sourceRecord.findUnique({ where: { sha256: hash }, select: { id: true } })) {
    result.sourceRecordsSkipped++;
    return;
  }

  await db.$transaction(async (tx) => {
    const audit: AuditEntry[] = [];
    let patientId: string | null = null;

    if (input.patient) {
      const key = { sourceSystem: SYNTHEA_SOURCE, sourcePatientId: input.patient.id };
      const existing = await tx.patient.findUnique({
        where: { sourceSystem_sourcePatientId: key },
        select: { id: true },
      });
      if (existing) {
        patientId = existing.id;
      } else if (input.format === "FHIR_BUNDLE") {
        const created = await tx.patient.create({
          data: {
            ...key,
            displayName: input.patient.displayName ?? null,
            birthDate: input.patient.birthDate ? new Date(input.patient.birthDate) : null,
            gender: input.patient.gender ?? null,
          },
          select: { id: true },
        });
        patientId = created.id;
        result.patientsCreated++;
        audit.push({ actor, action: "CREATE", patientId, entityType: "Patient", entityId: patientId, source: SYNTHEA_SOURCE });
      }
    }

    const record = await tx.sourceRecord.create({
      data: {
        patientId,
        format: input.format,
        sourceSystem: SYNTHEA_SOURCE,
        sourceRecordId: input.sourceRecordId,
        filename: input.filename,
        contentType: input.contentType,
        rawText: input.rawText,
        sha256: hash,
        byteSize: input.bytes.length,
        summary: input.summary as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    result.sourceRecordsCreated++;
    audit.push({
      actor,
      action: "CREATE",
      patientId,
      entityType: "SourceRecord",
      entityId: record.id,
      source: SYNTHEA_SOURCE,
      details: { format: input.format, byteSize: input.bytes.length },
    });

    await recordAudit(tx, audit);
  });
}
