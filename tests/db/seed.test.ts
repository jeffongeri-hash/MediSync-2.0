import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";
import { sha256 } from "@/ingest/source-summary";
import { dataKeys, keyIdOf, openText, rawTextAad } from "@/security/crypt";

const fixtures = join(process.cwd(), "fixtures/synthea");

// Runs against DATABASE_URL (migrated). Seeding is idempotent, so this is safe on a dev database.
describe.skipIf(!process.env.DATABASE_URL)("seedSynthea (database)", () => {
  const db = createDb();
  afterAll(() => db.$disconnect());

  it("loads 10 patients with their FHIR and C-CDA sources, idempotently", async () => {
    await seedSynthea(db, fixtures);
    const second = await seedSynthea(db, fixtures);
    expect(second).toMatchObject({ patientsCreated: 0, sourceRecordsCreated: 0 });

    const patients = await db.patient.findMany({
      where: { sourceSystem: SYNTHEA_SOURCE },
      include: { sourceRecords: { select: { format: true } } },
    });
    expect(patients).toHaveLength(10);
    for (const p of patients) {
      expect(p.sourceRecords.map((r) => r.format).sort()).toEqual(["CCDA", "FHIR_BUNDLE"]);
    }
  });

  it("stores raw sources byte-for-byte (sealed at rest when DATA_KEYS is set)", async () => {
    const file = readdirSync(join(fixtures, "fhir")).find((f) => f.endsWith(".json"))!;
    const bytes = readFileSync(join(fixtures, "fhir", file));
    const record = await db.sourceRecord.findUniqueOrThrow({ where: { sha256: sha256(bytes) } });
    if (dataKeys()) expect(keyIdOf(record.rawText)).toBe(dataKeys()!.current);
    const raw = openText(record.rawText, rawTextAad(record.sha256));
    expect(Buffer.from(raw, "utf8").equals(bytes)).toBe(true);
    expect(record.byteSize).toBe(bytes.length);
  });

  it("audits every created patient and source record", async () => {
    const patients = await db.patient.findMany({
      where: { sourceSystem: SYNTHEA_SOURCE },
      select: { id: true },
    });
    const audited = await db.auditLog.findMany({
      where: {
        action: "CREATE",
        entityType: "Patient",
        entityId: { in: patients.map((p) => p.id) },
      },
    });
    expect(new Set(audited.map((a) => a.entityId)).size).toBe(10);
  });

  it("keeps audit_log append-only", async () => {
    const entry = await db.auditLog.findFirstOrThrow();
    await expect(
      db.auditLog.update({ where: { id: entry.id }, data: { actor: "tampered" } }),
    ).rejects.toThrow();
    await expect(db.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});
