import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@/db";
import { runTransfer } from "@/export/run";
import { SendError, sendTransfer } from "@/export/send";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";
import { startMockSmart, type MockSmart } from "../mock-smart/server";

// Phase 7: a provider-approved dry run delivered to a receiving EHR (the test-only mock, as "EHR B").
describe.skipIf(!process.env.DATABASE_URL)(
  "sending a transfer to a receiving EHR (database)",
  () => {
    const db = createDb();
    const GATE_PATIENT = "c4a5ef89-933c-c428-8fa7-4a26d9f621a9"; // Synthea seed 3
    const AT = new Date("2026-11-24T00:00:00Z");
    const actor = "test:send";
    const FIXTURES = join(process.cwd(), "fixtures/synthea/fhir");
    let patientId: string;
    let ehrb: MockSmart;
    let down: MockSmart;
    const targets = () => [
      { name: "ehrb", label: "EHR B", url: ehrb.iss },
      { name: "down", label: "Down", url: down.iss },
    ];
    const dryRun = async () =>
      (await runTransfer(db, { patientId, actor, dryRun: true, exportedAt: AT })).jobId;

    beforeAll(async () => {
      await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
      await runMapping(db, { actor });
      patientId = (
        await db.patient.findFirstOrThrow({
          where: { sourceSystem: SYNTHEA_SOURCE, sourcePatientId: GATE_PATIENT },
        })
      ).id;
      const bundles = [
        join(FIXTURES, "Erik495_Hermiston71_a90ab4e3-5a52-2884-aadc-32cd5ec6357d.json"),
      ];
      ehrb = await startMockSmart({ port: 0, clientId: "ehrb", redirectUris: [], bundles });
      down = await startMockSmart({
        port: 0,
        clientId: "down",
        redirectUris: [],
        bundles,
        failTransactions: true,
      });
    }, 180_000);
    afterAll(async () => {
      await Promise.all([ehrb.close(), down.close()]);
      await db.$disconnect();
    });

    it("delivers the approved bundle: EHR B creates every entry and holds the patient under its own id", async () => {
      const approvedJobId = await dryRun();
      const approved = await db.transferJob.findUniqueOrThrow({ where: { id: approvedJobId } });
      const r = await sendTransfer(db, {
        approvedJobId,
        target: "ehrb",
        actor,
        targets: targets(),
      });
      expect(r.error).toBeNull();
      expect(r.delivered).toBe(true);

      const job = await db.transferJob.findUniqueOrThrow({ where: { id: r.jobId } });
      expect(job).toMatchObject({
        dryRun: false,
        approvedJobId,
        target: "ehrb",
        bundleSha256: approved.bundleSha256,
      });
      expect(job.deliveredAt).not.toBeNull();

      const got = ehrb.received.at(-1)!;
      const sent = (job.resourcesExported ?? 0) * 2; // each resource plus its Provenance
      expect(got.resources).toHaveLength(sent);
      expect(r.delivery!.targetPatientId).toBe(got.patientId);
      expect(r.delivery!.created.Patient).toBe(1);
      expect(r.delivery!.created.Provenance).toBe(job.resourcesExported);
      // References now point at EHR B's ids, never at the bundle's urn:uuids or the source's ids.
      const refs = JSON.stringify(got.resources).match(/"reference":"[^"]+"/g) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every((x) => /"reference":"[A-Z][A-Za-z]+\/rx-\d+"/.test(x))).toBe(true);

      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: r.jobId, source: "transfer:send" },
      });
      expect(audit).toMatchObject({ action: "EXPORT", actor, patientId });
      expect(audit.details).toMatchObject({
        target: "ehrb",
        approvedJobId,
        delivered: true,
        httpStatus: 200,
      });
    });

    it("one approval sends once", async () => {
      const approvedJobId = await dryRun();
      await sendTransfer(db, { approvedJobId, target: "ehrb", actor, targets: targets() });
      const before = ehrb.received.length;
      await expect(
        sendTransfer(db, { approvedJobId, target: "ehrb", actor, targets: targets() }),
      ).rejects.toThrow(/already sent/);
      expect(ehrb.received).toHaveLength(before);
    });

    it("refuses what is not an approvable dry run, and an unknown target", async () => {
      const real = await runTransfer(db, { patientId, actor, exportedAt: AT });
      await expect(
        sendTransfer(db, { approvedJobId: real.jobId, target: "ehrb", actor, targets: targets() }),
      ).rejects.toThrow(SendError);
      await expect(
        sendTransfer(db, {
          approvedJobId: await dryRun(),
          target: "epic",
          actor,
          targets: targets(),
        }),
      ).rejects.toThrow(/unknown transfer target/);
    });

    it("does not send when the record changed after approval", async () => {
      const approvedJobId = await dryRun();
      await db.transferJob.update({
        where: { id: approvedJobId },
        data: { bundleSha256: "0".repeat(64) },
      });
      const before = ehrb.received.length;
      const r = await sendTransfer(db, {
        approvedJobId,
        target: "ehrb",
        actor,
        targets: targets(),
      });
      expect(r).toMatchObject({ delivered: false, error: expect.stringMatching(/record changed/) });
      expect(ehrb.received).toHaveLength(before);
    });

    it("records a failed delivery on the job and in the audit log", async () => {
      const r = await sendTransfer(db, {
        approvedJobId: await dryRun(),
        target: "down",
        actor,
        targets: targets(),
      });
      expect(r).toMatchObject({ delivered: false, error: "down answered HTTP 500 (exception)" });
      const job = await db.transferJob.findUniqueOrThrow({ where: { id: r.jobId } });
      expect(job.deliveredAt).toBeNull();
      expect(job.delivery).toMatchObject({ httpStatus: 500 });
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: r.jobId, source: "transfer:send" },
      });
      expect(audit.details).toMatchObject({ delivered: false, httpStatus: 500 });
    });
  },
);
