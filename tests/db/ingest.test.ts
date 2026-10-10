import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { ingestSource } from "@/ingest/ingest";
import { loadReportInput, patientLines } from "@/ingest/report";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";

const root = process.cwd();

// Phase 1 gate: every synthetic patient ingests from bundle, NDJSON and C-CDA, with an issue report.
describe.skipIf(!process.env.DATABASE_URL)("ingest (database)", () => {
  const db = createDb();
  // The bad-NDJSON case uses its own source system; remove it so other suites (e.g. /demo e2e) see only Synthea.
  const dropTestBulk = async () => {
    const where = { sourceSystem: "test-bulk" };
    const ids = (await db.sourceRecord.findMany({ where, select: { id: true } })).map((r) => r.id);
    await db.mappingIssue.deleteMany({ where: { sourceRecordId: { in: ids } } });
    await db.canonicalResource.deleteMany({ where: { sourceRecordId: { in: ids } } });
    await db.sourceRecord.deleteMany({ where });
    await db.patient.deleteMany({ where });
  };
  beforeAll(async () => {
    await dropTestBulk();
    await seedSynthea(db, join(root, "fixtures/synthea"));
  }, 120_000);
  afterAll(async () => {
    await dropTestBulk();
    await db.$disconnect();
  });

  it("ingests all 10 Synthea patients in all three formats with no ERROR issues", async () => {
    const lines = patientLines(await loadReportInput(db, SYNTHEA_SOURCE, "test"));
    expect(lines).toHaveLength(10);
    for (const l of lines) {
      expect(l.canonical.FHIR_BUNDLE, l.patient).toBeGreaterThan(0);
      expect(l.canonical.FHIR_NDJSON, l.patient).toBe(l.canonical.FHIR_BUNDLE);
      expect(l.canonical.CCDA, l.patient).toBeGreaterThan(0);
      expect(l.issues.ERROR, l.patient).toBe(0);
    }
  });

  it("gives every patient a Patient plus clinical data from each format, with provenance", async () => {
    const rows = await db.$queryRaw<{ patient_id: string; format: string; types: string[]; missing_path: number }[]>`
      SELECT c.patient_id::text, s.format::text, array_agg(DISTINCT c.resource_type) AS types,
             count(*) FILTER (WHERE c.source_path IS NULL)::int AS missing_path
      FROM canonical_resources c JOIN source_records s ON s.id = c.source_record_id
      WHERE s.source_system = ${SYNTHEA_SOURCE} GROUP BY 1, 2`;
    expect(rows).toHaveLength(30);
    for (const r of rows) {
      expect(r.types).toContain("Patient");
      expect(r.types.some((t) => t === "Condition" || t === "Observation")).toBe(true);
      expect(r.missing_path).toBe(0);
    }
  });

  it("is idempotent and audits canonical writes per patient", async () => {
    const again = await seedSynthea(db, join(root, "fixtures/synthea"));
    expect(again).toMatchObject({ sourceRecordsCreated: 0, sourcesParsed: 0, canonicalCreated: 0 });
    const audited = await db.auditLog.findMany({
      where: { entityType: "CanonicalResource", source: SYNTHEA_SOURCE },
      select: { patientId: true },
    });
    expect(new Set(audited.map((a) => a.patientId)).size).toBe(10);
  });

  it("keeps a bad NDJSON file's good lines and records each problem", async () => {
    const bytes = readFileSync(join(root, "fixtures/ingest/bulk-mixed.ndjson"));
    const src = { sourceSystem: "test-bulk", format: "FHIR_NDJSON" as const, filename: "bulk-mixed.ndjson", bytes, contentType: "application/fhir+ndjson" };
    await ingestSource(db, src, "test");
    const record = await db.sourceRecord.findFirstOrThrow({ where: { sourceSystem: "test-bulk" }, select: { id: true, parsedAt: true } });
    expect(record.parsedAt).not.toBeNull();
    const kept = await db.canonicalResource.findMany({ where: { sourceRecordId: record.id }, select: { fhirId: true } });
    expect(kept.map((k) => k.fhirId).sort()).toEqual(["imm-1", "p-0002"]);
    const issues = await db.mappingIssue.findMany({ where: { sourceRecordId: record.id }, select: { code: true, severity: true } });
    expect(issues.map((i) => `${i.severity}:${i.code}`).sort()).toEqual([
      "ERROR:parse_error",
      "ERROR:schema_invalid",
      "WARNING:unknown_patient",
      "WARNING:unresolved_reference",
    ]);
  });
});
