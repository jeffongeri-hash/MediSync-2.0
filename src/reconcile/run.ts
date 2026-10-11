// Database side of reconciliation: run (rules + summary), view, and provider decisions. Writes only the
// reconciliation_* tables and audit_log; canonical rows are never touched. Every read and write is audited.
import type { Db } from "@/db";
import { recordAudit, type AuditEntry } from "@/audit";
import { anthropicResponder, templateResponder, type Responder } from "@/ai/responders";
import { summarize } from "@/ai/summarize";
import { toCanonical } from "@/canonical";
import type { Prisma } from "@/generated/prisma/client";
import { buildReconciliation, distinctFlags, type ReconItem } from "@/reconcile/build";
import { lastEncounter, loadSourceRows } from "@/reconcile/load";
import { defaultCutoff, type ReconRow } from "@/reconcile/rows";

export const RECONCILE_SOURCE = "reconcile";

/** Live Claude when a key is configured, else the rule-built template (labelled as such in the UI). */
export function defaultResponder(env: Record<string, string | undefined> = process.env): Responder {
  return env.ANTHROPIC_API_KEY
    ? anthropicResponder({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL })
    : templateResponder();
}

const count = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});

export async function runReconciliation(
  db: Db,
  opts: { patientId: string; actor: string; cutoff?: Date; responder?: Responder },
): Promise<{ runId: string }> {
  const { patientId, actor } = opts;
  const rows = await loadSourceRows(db, patientId);
  const last = await lastEncounter(db, patientId);
  const cutoff = opts.cutoff ?? (last ? defaultCutoff(last) : new Date());
  const recon = buildReconciliation(rows, cutoff);
  const responder = opts.responder ?? defaultResponder();
  const s = await summarize(recon, responder);
  const valid = s.checked.claims.filter((c) => c.valid).length;
  const summary = {
    rowsCurrent: recon.current.length,
    rowsIncoming: recon.incoming.length,
    items: count(recon.items, (it) => `${it.category}/${it.match}`),
    flags: count(distinctFlags(recon.items), (f) => f.code),
    claimsValid: valid,
    claimsDropped: s.checked.claims.length - valid,
  };

  const run = await db.$transaction(async (tx) => {
    const created = await tx.reconciliationRun.create({
      data: {
        patientId,
        requestedBy: actor,
        cutoff,
        rulesVersion: recon.rulesVersion,
        responder: responder.name,
        aiStatus: s.checked.error ? "failed" : "ok",
        model: s.response.model ?? responder.model,
        servedModel: s.response.servedModel,
        promptVersion: s.request.promptVersion,
        inputSha256: s.request.inputSha256,
        aiRaw: s.response.raw,
        aiError: s.checked.error,
        summary,
      },
    });
    await tx.reconciliationItem.createMany({
      data: recon.items.map((it) => ({
        runId: created.id,
        ordinal: it.ordinal,
        category: it.category,
        match: it.match,
        currentId: it.current?.id ?? null,
        incomingId: it.incoming?.id ?? null,
        current: (it.current ?? undefined) as Prisma.InputJsonValue | undefined,
        incoming: (it.incoming ?? undefined) as Prisma.InputJsonValue | undefined,
        flags: it.flags as unknown as Prisma.InputJsonValue,
      })),
    });
    await tx.reconciliationClaim.createMany({
      data: s.checked.claims.map((c, ordinal) => ({
        runId: created.id,
        ordinal,
        kind: c.kind,
        topic: c.topic,
        text: c.text,
        citedAliases: c.citedAliases,
        sourceIds: c.sourceIds,
        valid: c.valid,
        problems: c.problems,
      })),
    });
    const audit: AuditEntry[] = [
      {
        actor,
        action: "READ",
        patientId,
        entityType: "Patient",
        entityId: patientId,
        source: RECONCILE_SOURCE,
        details: { rows: rows.length, runId: created.id },
      },
      {
        actor,
        action: "CREATE",
        patientId,
        entityType: "ReconciliationRun",
        entityId: created.id,
        source: RECONCILE_SOURCE,
        details: { items: recon.items.length, claimsValid: valid, responder: responder.name },
      },
    ];
    // Records leave the system only for the live model; that disclosure is its own entry.
    if (responder.name === "anthropic")
      audit.push({
        actor,
        action: "EXPORT",
        patientId,
        entityType: "ReconciliationRun",
        entityId: created.id,
        source: "anthropic",
        details: {
          rowsSent: s.prepared.input.rows.length,
          model: s.response.model ?? responder.model,
          promptVersion: s.request.promptVersion,
          inputSha256: s.request.inputSha256,
        },
      });
    await recordAudit(tx, audit);
    return created;
  });
  return { runId: run.id };
}

export type DecisionTarget = { itemId: string } | { claimId: string };
export class DecisionError extends Error {}

/** Appends one provider decision. EDIT stores a provider-authored copy validated against the canonical schema. */
export async function recordDecision(
  db: Db,
  opts: {
    runId: string;
    target: DecisionTarget;
    action: "ACCEPT" | "REJECT" | "EDIT";
    actor: string;
    note?: string;
    editedResource?: unknown;
  },
): Promise<{ decisionId: bigint }> {
  const run = await db.reconciliationRun.findUnique({ where: { id: opts.runId } });
  if (!run) throw new DecisionError("Unknown reconciliation run.");
  let edited: Prisma.InputJsonValue | undefined;
  if ("itemId" in opts.target) {
    const item = await db.reconciliationItem.findFirst({
      where: { id: opts.target.itemId, runId: run.id },
    });
    if (!item) throw new DecisionError("Item is not part of this run.");
    if (opts.action === "EDIT") {
      const shown = (item.incoming ?? item.current) as ReconRow | null;
      const result = toCanonical(opts.editedResource, "provider-edit");
      if (!result.resource) throw new DecisionError(result.issues.map((i) => i.message).join("; "));
      if (result.resource.resourceType !== shown?.resourceType)
        throw new DecisionError(`The edited copy must be a ${shown?.resourceType ?? "resource"}.`);
      edited = result.resource as Prisma.InputJsonValue;
    }
  } else {
    const claim = await db.reconciliationClaim.findFirst({
      where: { id: opts.target.claimId, runId: run.id },
    });
    if (!claim) throw new DecisionError("Claim is not part of this run.");
    if (!claim.valid) throw new DecisionError("Dropped claims cannot be accepted or rejected.");
    if (opts.action === "EDIT")
      throw new DecisionError("AI statements can be accepted or rejected, not edited.");
  }
  const target = "itemId" in opts.target ? "item" : "claim";
  return db.$transaction(async (tx) => {
    const d = await tx.reconciliationDecision.create({
      data: {
        runId: run.id,
        itemId: "itemId" in opts.target ? opts.target.itemId : null,
        claimId: "claimId" in opts.target ? opts.target.claimId : null,
        action: opts.action,
        actor: opts.actor,
        note: opts.note?.trim() || null,
        editedResource: edited,
      },
    });
    await recordAudit(tx, {
      actor: opts.actor,
      action: "CREATE",
      patientId: run.patientId,
      entityType: "ReconciliationDecision",
      entityId: d.id.toString(),
      source: RECONCILE_SOURCE,
      details: { runId: run.id, target, decision: opts.action },
    });
    return { decisionId: d.id };
  });
}

export type RunView = NonNullable<Awaited<ReturnType<typeof loadRunView>>>;

/** The latest run for a patient (or a given run), with items, claims and the latest decision per target. */
export async function loadRunView(
  db: Db,
  opts: { patientId: string; runId?: string; actor: string },
) {
  const run = await db.reconciliationRun.findFirst({
    where: { patientId: opts.patientId, ...(opts.runId ? { id: opts.runId } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      items: { orderBy: { ordinal: "asc" } },
      claims: { orderBy: { ordinal: "asc" } },
      decisions: { orderBy: { id: "asc" } },
    },
  });
  await recordAudit(db, {
    actor: opts.actor,
    action: "READ",
    patientId: opts.patientId,
    entityType: run ? "ReconciliationRun" : "Patient",
    entityId: run?.id ?? opts.patientId,
    source: RECONCILE_SOURCE,
  });
  if (!run) return null;
  const latest = new Map<string, (typeof run.decisions)[number]>();
  for (const d of run.decisions) latest.set(d.itemId ?? d.claimId!, d);
  return {
    ...run,
    items: run.items.map((it) => ({
      ...it,
      current: it.current as ReconRow | null,
      incoming: it.incoming as ReconRow | null,
      flags: it.flags as unknown as ReconItem["flags"],
      decision: latest.get(it.id) ?? null,
    })),
    claims: run.claims.map((c) => ({ ...c, decision: latest.get(c.id) ?? null })),
  };
}
