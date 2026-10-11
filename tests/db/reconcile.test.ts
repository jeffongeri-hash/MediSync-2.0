import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Responder } from "@/ai/responders";
import { createDb } from "@/db";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";
import { DecisionError, loadRunView, recordDecision, runReconciliation } from "@/reconcile/run";
import { templateResponder } from "@/ai/responders";

// Phase 4: a reconciliation run persists items, claims and audit entries, writes no canonical row, and provider
// decisions are validated, audited and append-only.
describe.skipIf(!process.env.DATABASE_URL)("reconciliation (database)", () => {
  const db = createDb();
  const PATIENT = "c4a5ef89-933c-c428-8fa7-4a26d9f621a9"; // Synthea seed 3: allergies and Medication refs
  const actor = "test:reconcile";
  let patientId: string;

  beforeAll(async () => {
    await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
    await runMapping(db, { actor });
    patientId = (
      await db.patient.findFirstOrThrow({
        where: { sourceSystem: SYNTHEA_SOURCE, sourcePatientId: PATIENT },
      })
    ).id;
  }, 180_000);
  afterAll(() => db.$disconnect());

  const canonicalState = () =>
    db.$queryRaw<{ n: bigint; latest: Date | null }[]>`
      SELECT count(*) AS n, max(updated_at) AS latest FROM canonical_resources`;

  it("persists a run with cited flags and valid template claims, and never writes canonical rows", async () => {
    const before = await canonicalState();
    const { runId } = await runReconciliation(db, {
      patientId,
      actor,
      responder: templateResponder(),
    });
    expect(await canonicalState()).toEqual(before);

    const view = await loadRunView(db, { patientId, runId, actor });
    expect(view).not.toBeNull();
    expect(view!).toMatchObject({ responder: "template", aiStatus: "ok", aiError: null });
    expect(view!.items.length).toBeGreaterThan(10);
    const rowIds = new Set(
      view!.items.flatMap((it) => [it.currentId, it.incomingId]).filter(Boolean),
    );
    for (const it of view!.items)
      for (const f of it.flags) for (const s of f.sourceIds) expect(rowIds.has(s)).toBe(true);
    expect(view!.claims.length).toBeGreaterThan(0);
    expect(view!.claims.every((c) => c.valid && c.sourceIds.every((s) => rowIds.has(s)))).toBe(
      true,
    );
    expect(view!.items.some((it) => it.category === "ALLERGY")).toBe(true);

    const audit = await db.auditLog.findMany({
      where: { OR: [{ entityId: runId }, { details: { path: ["runId"], equals: runId } }] },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(["CREATE", "READ", "READ"]);
    expect(audit.some((a) => a.action === "EXPORT")).toBe(false);
  });

  it("logs the disclosure when records go to the live model", async () => {
    const live: Responder = { ...templateResponder(), name: "anthropic", model: "test-model" };
    const { runId } = await runReconciliation(db, { patientId, actor, responder: live });
    const exp = await db.auditLog.findFirstOrThrow({
      where: { entityId: runId, action: "EXPORT" },
    });
    expect(exp).toMatchObject({ source: "anthropic", patientId });
    expect(exp.details).toMatchObject({ model: "test-model" });
  });

  it("records decisions append-only, validates edits, and shows the latest per target", async () => {
    const { runId } = await runReconciliation(db, {
      patientId,
      actor,
      responder: templateResponder(),
    });
    const view = (await loadRunView(db, { patientId, runId, actor }))!;
    const item = view.items.find((it) => it.incoming?.resourceType === "Condition")!;
    const claim = view.claims[0]!;

    await recordDecision(db, { runId, target: { itemId: item.id }, action: "REJECT", actor });
    const resource = {
      ...((await db.canonicalResource.findUniqueOrThrow({ where: { id: item.incomingId! } }))
        .mapped as object),
    };
    const edited = { ...resource, note: [{ text: "Provider: onset per patient report" }] };
    const { decisionId } = await recordDecision(db, {
      runId,
      target: { itemId: item.id },
      action: "EDIT",
      actor,
      editedResource: edited,
    });
    await recordDecision(db, {
      runId,
      target: { claimId: claim.id },
      action: "ACCEPT",
      actor,
      note: " ok ",
    });

    await expect(
      recordDecision(db, {
        runId,
        target: { itemId: item.id },
        action: "EDIT",
        actor,
        editedResource: { resourceType: "Condition" },
      }),
    ).rejects.toThrow(DecisionError);
    await expect(
      recordDecision(db, {
        runId,
        target: { itemId: item.id },
        action: "EDIT",
        actor,
        editedResource: { resourceType: "Observation", status: "final", code: {} },
      }),
    ).rejects.toThrow(DecisionError);
    await expect(
      recordDecision(db, {
        runId,
        target: { claimId: claim.id },
        action: "EDIT",
        actor,
        editedResource: edited,
      }),
    ).rejects.toThrow(/not edited/);

    const after = (await loadRunView(db, { patientId, runId, actor }))!;
    expect(after.items.find((it) => it.id === item.id)!.decision).toMatchObject({
      action: "EDIT",
      id: decisionId,
    });
    expect(after.claims[0]!.decision).toMatchObject({ action: "ACCEPT", note: "ok" });
    const stored = await db.reconciliationDecision.findUniqueOrThrow({ where: { id: decisionId } });
    expect(stored.editedResource).toMatchObject({
      note: [{ text: "Provider: onset per patient report" }],
    });

    const decisionAudit = await db.auditLog.count({
      where: { entityType: "ReconciliationDecision", details: { path: ["runId"], equals: runId } },
    });
    expect(decisionAudit).toBe(3);
    await expect(
      db.$executeRaw`UPDATE reconciliation_decisions SET action = 'ACCEPT' WHERE id = ${decisionId}`,
    ).rejects.toThrow(/append-only/);
  });
});
