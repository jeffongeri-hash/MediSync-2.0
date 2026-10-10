import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { ingestSource } from "@/ingest/ingest";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";
import { MAPPING_VERSION } from "@/mapping/map-resource";
import { loadMappingReportInput, renderMappingReport } from "@/mapping/report";
import { runMapping } from "@/mapping/run";

// Phase 2: invariants of the mapping pass over the seeded Synthea data. Safe on a dev database (idempotent).
describe.skipIf(!process.env.DATABASE_URL)("mapping pass (database)", () => {
  const db = createDb();
  const synthea = { sourceRecord: { sourceSystem: SYNTHEA_SOURCE } };
  // The edge-case fixture uses its own source system and is removed afterwards, so other suites see only Synthea.
  const TEST_SOURCE = "test-mapping";
  const dropTestSource = async () => {
    const where = { sourceSystem: TEST_SOURCE };
    const ids = (await db.sourceRecord.findMany({ where, select: { id: true } })).map((r) => r.id);
    await db.mappingIssue.deleteMany({ where: { sourceRecordId: { in: ids } } });
    await db.canonicalResource.deleteMany({ where: { sourceRecordId: { in: ids } } });
    await db.sourceRecord.deleteMany({ where });
    await db.patient.deleteMany({ where });
  };
  beforeAll(async () => {
    await dropTestSource();
    await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
    await runMapping(db, { actor: "test:mapping" });
  }, 180_000);
  afterAll(async () => {
    await dropTestSource();
    await db.$disconnect();
  });

  it("maps every row at the current version, and a second run does nothing", async () => {
    expect(await db.canonicalResource.count({ where: { ...synthea, OR: [{ mappingVersion: { not: MAPPING_VERSION } }, { mappingStatus: null }] } })).toBe(0);
    expect(await runMapping(db)).toEqual({ patients: 0, mapped: 0, duplicatesLinked: 0, issues: 0 });
  });

  it("puts every UNMAPPED row in the review queue and resolves every medicationReference", async () => {
    const unmapped = await db.canonicalResource.findMany({ where: { mappingStatus: "UNMAPPED" }, select: { id: true } });
    const queued = await db.mappingIssue.count({ where: { stage: "MAPPING", code: "unmapped_code", canonicalResourceId: { in: unmapped.map((r) => r.id) } } });
    expect(queued).toBeGreaterThanOrEqual(unmapped.length);
    const refs = await db.canonicalResource.findMany({
      where: { ...synthea, resourceType: "MedicationRequest", resource: { path: ["medicationReference", "reference"], string_starts_with: "Medication/" } },
      select: { mappingStatus: true, codeSystem: true },
    });
    expect(refs).toHaveLength(9 * 2); // 9 in the Bundle sources, 9 in NDJSON
    for (const r of refs) expect(r).toEqual({ mappingStatus: "MAPPED", codeSystem: "http://www.nlm.nih.gov/research/umls/rxnorm" });
  });

  it("queues every unmapped code from the edge-case fixture, tied to its canonical row", async () => {
    const bytes = readFileSync(join(process.cwd(), "fixtures/mapping/bundle-mapping.json"));
    const input = { format: "FHIR_BUNDLE" as const, sourceSystem: TEST_SOURCE, filename: "bundle-mapping.json", bytes, contentType: "application/fhir+json" };
    await ingestSource(db, input, "test:mapping");
    expect(await runMapping(db, { actor: "test:mapping" })).toMatchObject({ patients: 1, mapped: 15 });
    const rows = await db.canonicalResource.findMany({
      where: { sourceRecord: { sourceSystem: TEST_SOURCE } },
      select: { fhirId: true, mappingStatus: true, mappingIssues: { where: { stage: "MAPPING" }, select: { code: true } } },
    });
    const status = Object.fromEntries(rows.map((r) => [r.fhirId, r.mappingStatus]));
    expect(status).toMatchObject({ "cond-unknown": "UNMAPPED", "cond-oid-typo": "UNMAPPED", "proc-cpt": "UNMAPPED", "obs-bad-check": "UNMAPPED", "mr-dangling": "NO_CODE", "mr-ref": "MAPPED" });
    for (const r of rows.filter((x) => x.mappingStatus === "UNMAPPED")) expect(r.mappingIssues.map((i) => i.code), r.fhirId).toContain("unmapped_code");
    expect(rows.find((r) => r.fhirId === "obs-bp")!.mappingIssues).toEqual([{ code: "unmapped_unit" }]);
  });

  it("links every NDJSON and C-CDA row to a Bundle primary of the same patient, without chains", async () => {
    const rows = await db.canonicalResource.findMany({
      where: synthea,
      select: { id: true, patientId: true, duplicateOfId: true, sourceRecord: { select: { format: true } } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      if (r.sourceRecord.format === "FHIR_BUNDLE") {
        expect(r.duplicateOfId).toBeNull();
        continue;
      }
      const primary = byId.get(r.duplicateOfId ?? "");
      expect(primary?.sourceRecord.format, r.id).toBe("FHIR_BUNDLE");
      expect(primary?.patientId).toBe(r.patientId);
    }
  });

  it("passes the Phase 2 gate: coverage report renders and no unmapped finding is missing from the queue", async () => {
    const input = await loadMappingReportInput(db, SYNTHEA_SOURCE, MAPPING_VERSION);
    expect(input.notQueued).toEqual({ unmappedRows: 0, conditionsWithoutIcd: 0 });
    const md = renderMappingReport(input);
    expect(md).toContain("missing from the review queue: 0 (pass)");
    expect(md).toContain("| Condition | 405 | 405 | 0 | 0 | 100.0% | 52 |");
  });

  it("keeps a reviewer's decision when everything is re-mapped", async () => {
    const one = await db.mappingIssue.findFirstOrThrow({ where: { stage: "MAPPING", status: "OPEN" }, orderBy: { id: "asc" } });
    const total = await db.mappingIssue.count({ where: { stage: { not: "INGEST" } } });
    await db.mappingIssue.update({ where: { id: one.id }, data: { status: "IGNORED", resolvedBy: "test", resolvedAt: new Date() } });
    try {
      await runMapping(db, { actor: "test:mapping", all: true });
      expect(await db.mappingIssue.count({ where: { stage: { not: "INGEST" } } })).toBe(total);
      expect(await db.mappingIssue.count({ where: { canonicalResourceId: one.canonicalResourceId, code: one.code, message: one.message } })).toBe(1);
    } finally {
      await db.mappingIssue.update({ where: { id: one.id }, data: { status: "OPEN", resolvedBy: null, resolvedAt: null } });
    }
  }, 180_000);
});
