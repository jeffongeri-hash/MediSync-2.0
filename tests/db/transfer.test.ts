import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { sha256, transactionBundleSchema } from "@/export/bundle";
import { PatientNotFoundError, runTransfer } from "@/export/run";
import { openAtRest } from "@/security/at-rest";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";

// Phase 3 gate: end-to-end transfer of one synthetic patient, plus job, audit and issue invariants.
// Safe on a dev database: jobs and audit entries accumulate, EXPORT issues are replaced per run.
describe.skipIf(!process.env.DATABASE_URL)("transfer jobs (database)", () => {
  const db = createDb();
  const GATE_PATIENT = "c4a5ef89-933c-c428-8fa7-4a26d9f621a9"; // Synthea seed 3: allergies, Medication refs, open warnings
  const AT = new Date("2026-10-11T00:00:00Z");
  const actor = "test:transfer";
  const previousKey = process.env.MEDISYNC_DATA_KEY;
  let patientId: string;
  let familyName: string;

  beforeAll(async () => {
    process.env.MEDISYNC_DATA_KEY = Buffer.alloc(32, 7).toString("base64");
    await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
    await runMapping(db, { actor });
    const patient = await db.patient.findFirstOrThrow({
      where: { sourceSystem: SYNTHEA_SOURCE, sourcePatientId: GATE_PATIENT },
    });
    patientId = patient.id;
    const row = await db.canonicalResource.findFirstOrThrow({
      where: { patientId, resourceType: "Patient", duplicateOfId: null },
    });
    familyName = (row.resource as { name: { family: string }[] }).name[0]!.family;
  }, 180_000);
  afterAll(() => {
    if (previousKey === undefined) delete process.env.MEDISYNC_DATA_KEY;
    else process.env.MEDISYNC_DATA_KEY = previousKey;
    return db.$disconnect();
  });

  it("exports one patient end to end: stored, hashed, valid bundle with one Provenance per resource", async () => {
    const r = await runTransfer(db, { patientId, actor, exportedAt: AT });
    expect(r.status, r.error ?? "").toBe("SUCCEEDED");
    const job = await db.transferJob.findUniqueOrThrow({ where: { id: r.jobId } });
    expect(job).toMatchObject({
      status: "SUCCEEDED",
      dryRun: false,
      targetProfile: "us-core@6.1.0",
      requestedBy: actor,
    });
    expect(job.finishedAt).not.toBeNull();
    expect(job.bundle!.startsWith("enc1:")).toBe(true);
    expect(openAtRest(job.bundle!)).toBe(r.bundleText);
    expect(job.bundle).not.toContain(familyName);
    expect(job.bundleSha256).toBe(sha256(r.bundleText!));
    expect(job.bundleBytes).toBe(Buffer.byteLength(r.bundleText!));

    const primaries = await db.canonicalResource.count({
      where: { patientId, duplicateOfId: null },
    });
    const bundle = transactionBundleSchema.parse(JSON.parse(r.bundleText!));
    const types = bundle.entry.map((e) => e.resource.resourceType);
    expect(job.resourcesSelected).toBe(primaries);
    expect(job.resourcesExcluded).toBe(0);
    expect(types.filter((t) => t === "Provenance")).toHaveLength(primaries);
    expect(types[0]).toBe("Patient");
    expect(job.completeness).toBeGreaterThan(0.95);
    expect(job.report).toContain("# Transfer fidelity report");
    expect(job.report).toContain("## What would be lost");
  });

  it("writes one EXPORT audit entry per job, with ids and counts only", async () => {
    const r = await runTransfer(db, { patientId, actor, dryRun: true, exportedAt: AT });
    const entries = await db.auditLog.findMany({
      where: { entityType: "TransferJob", entityId: r.jobId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "EXPORT", actor, patientId, source: "transfer" });
    expect(entries[0]!.details).toMatchObject({ dryRun: true, status: "SUCCEEDED", excluded: 0 });
    const job = await db.transferJob.findUniqueOrThrow({ where: { id: r.jobId } });
    for (const text of [
      JSON.stringify(entries[0]!.details),
      JSON.stringify(job.summary),
      job.report!,
    ]) {
      expect(text).not.toContain(familyName);
    }
  });

  it("a dry run keeps no bundle, and the same export time yields the same hash", async () => {
    const exported = await runTransfer(db, { patientId, actor, exportedAt: AT });
    const dry = await runTransfer(db, { patientId, actor, dryRun: true, exportedAt: AT });
    const job = await db.transferJob.findUniqueOrThrow({ where: { id: dry.jobId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.bundle).toBeNull();
    expect(dry.bundleText).toBeNull();
    expect(job.bundleSha256).toBe(exported.bundleSha256);
  });

  it("replaces its own OPEN EXPORT issues on a re-run and never touches earlier stages", async () => {
    const count = (stage: "EXPORT" | "MAPPING") =>
      db.mappingIssue.count({ where: { patientId, stage } });
    await runTransfer(db, { patientId, actor, dryRun: true, exportedAt: AT });
    const exportIssues = await count("EXPORT");
    const mappingIssues = await count("MAPPING");
    expect(exportIssues).toBeGreaterThan(0);
    await runTransfer(db, { patientId, actor, dryRun: true, exportedAt: AT });
    expect(await count("EXPORT")).toBe(exportIssues);
    expect(await count("MAPPING")).toBe(mappingIssues);
    const codes = await db.mappingIssue.findMany({
      where: { patientId, stage: "EXPORT" },
      distinct: ["code"],
      select: { code: true },
    });
    expect(
      codes.map((c) => c.code).every((c) => c.startsWith("profile_") || c === "no_target_profile"),
    ).toBe(true);
  });

  it("transfers every seeded patient in a dry run with nothing excluded and >= 90% completeness", async () => {
    const patients = await db.patient.findMany({
      where: { sourceSystem: SYNTHEA_SOURCE },
      select: { id: true },
    });
    expect(patients).toHaveLength(10);
    for (const p of patients) {
      const r = await runTransfer(db, { patientId: p.id, actor, dryRun: true, exportedAt: AT });
      expect(r.status, r.error ?? "").toBe("SUCCEEDED");
      expect(r.resourcesExcluded).toBe(0);
      expect(r.completeness).toBeGreaterThanOrEqual(0.9);
    }
  }, 120_000);

  it("fails the job, without throwing, when rows are not mapped at the current version", async () => {
    const row = await db.canonicalResource.findFirstOrThrow({
      where: { patientId, resourceType: "Condition" },
    });
    await db.canonicalResource.update({ where: { id: row.id }, data: { mappingVersion: "stale" } });
    try {
      const r = await runTransfer(db, { patientId, actor, exportedAt: AT });
      expect(r.status).toBe("FAILED");
      expect(r.error).toMatch(/not mapped at .*run pnpm map first/);
      const job = await db.transferJob.findUniqueOrThrow({ where: { id: r.jobId } });
      expect(job).toMatchObject({ status: "FAILED", bundle: null });
      const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: r.jobId } });
      expect(audit.details).toMatchObject({ status: "FAILED" });
    } finally {
      await db.canonicalResource.update({
        where: { id: row.id },
        data: { mappingVersion: row.mappingVersion },
      });
    }
  });

  it("rejects an unknown patient before creating a job", async () => {
    const before = await db.transferJob.count();
    await expect(
      runTransfer(db, { patientId: "00000000-0000-4000-8000-000000000000", actor }),
    ).rejects.toBeInstanceOf(PatientNotFoundError);
    expect(await db.transferJob.count()).toBe(before);
  });
});
