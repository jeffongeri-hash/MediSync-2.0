import type { Db } from "@/db";
import { recordAudit } from "@/audit";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import type { CcdaSummary, FhirBundleSummary } from "@/ingest/source-summary";
import { openText, rawTextAad } from "@/security/crypt";

const PREVIEW_CHARS = 900;

export async function getDemoData(db: Db, actor: string) {
  const [counts, patients, references, previews] = await Promise.all([
    Promise.all([
      db.patient.count(),
      db.sourceRecord.count(),
      db.canonicalResource.count(),
      db.mappingIssue.count({ where: { status: "OPEN" } }),
      db.auditLog.count(),
    ]),
    // Seeded patients only; SMART-launched patients are reachable only from their launch.
    db.patient.findMany({
      where: { sourceSystem: SYNTHEA_SOURCE },
      orderBy: { displayName: "asc" },
      select: {
        id: true,
        displayName: true,
        gender: true,
        birthDate: true,
        sourceSystem: true,
        sourcePatientId: true,
        sourceRecords: {
          orderBy: { format: "desc" },
          select: {
            id: true,
            format: true,
            filename: true,
            byteSize: true,
            sha256: true,
            receivedAt: true,
            summary: true,
          },
        },
      },
    }),
    db.sourceRecord.findMany({
      where: { patientId: null },
      orderBy: { filename: "asc" },
      select: { id: true, filename: true, byteSize: true, sha256: true, summary: true },
    }),
    // raw_text is encrypted at rest, so the preview is cut after decrypting (shortcut: reads whole documents of a few
    // MB each; store a separate sealed preview if /demo ever serves more than the seeded set).
    db.sourceRecord.findMany({
      where: { patientId: { not: null } },
      select: { id: true, sha256: true, rawText: true },
    }),
  ]);

  await recordAudit(
    db,
    patients.map((p) => ({
      actor,
      action: "READ" as const,
      patientId: p.id,
      entityType: "Patient",
      entityId: p.id,
      source: "demo",
    })),
  );

  // Read after logging so the page shows its own READ entries.
  const recentAudit = await db.auditLog.findMany({ orderBy: { id: "desc" }, take: 12 });
  const previewById = new Map(
    previews.map((r) => [r.id, openText(r.rawText, rawTextAad(r.sha256)).slice(0, PREVIEW_CHARS)]),
  );
  const [patientCount, sourceRecordCount, canonicalCount, openIssueCount, auditCount] = counts;

  return {
    counts: { patientCount, sourceRecordCount, canonicalCount, openIssueCount, auditCount },
    patients: patients.map((p) => {
      const fhir = p.sourceRecords.find((r) => r.format === "FHIR_BUNDLE");
      const ccda = p.sourceRecords.find((r) => r.format === "CCDA");
      return {
        ...p,
        fhirSummary: (fhir?.summary ?? null) as FhirBundleSummary | null,
        ccdaSummary: (ccda?.summary ?? null) as CcdaSummary | null,
        sourceRecords: p.sourceRecords.map((r) => ({ ...r, preview: previewById.get(r.id) ?? "" })),
      };
    }),
    references: references.map((r) => ({ ...r, summary: r.summary as FhirBundleSummary | null })),
    recentAudit,
  };
}

export type DemoData = Awaited<ReturnType<typeof getDemoData>>;
