"use server";
// Reconcile form actions. Plain <form> posts, so they work without client JS. Both need the provider role: on a
// patient opened by a SMART launch, as the launch's user and only from that launch; on a seeded patient, as the demo
// provider in demo mode. Nothing here writes canonical rows.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { DecisionError, recordDecision, runReconciliation } from "@/reconcile/run";
import { allows, Role, RoleError } from "@/security/roles";
import { RULES } from "@/security/ratelimit";
import { limitAction, patientAccess } from "@/smart/next";

async function access(patientId: string) {
  const patient = await getDb().patient.findUniqueOrThrow({
    where: { id: patientId },
    select: { id: true, sourceSystem: true },
  });
  const a = await patientAccess(patient);
  if (!a) redirect("/smart?error=no_session");
  const wait = await limitAction(RULES.decide, a.session);
  if (wait !== null)
    redirect(`/reconcile/${patientId}?error=${encodeURIComponent(`Too many requests. Try again in ${wait} seconds.`)}`);
  if (!allows(a.role, Role.PROVIDER))
    redirect(
      `/reconcile/${patientId}?error=${encodeURIComponent(new RoleError(Role.PROVIDER, a.role).message)}`,
    );
  return a;
}

const runForm = z.object({ patientId: z.uuid() });
const decideForm = z.object({
  patientId: z.uuid(),
  runId: z.uuid(),
  itemId: z.uuid().optional(),
  claimId: z.uuid().optional(),
  anchor: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  action: z.enum(["ACCEPT", "REJECT", "EDIT"]),
  note: z.string().max(500).optional(),
  edited: z.string().max(200_000).optional(),
});

const field = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

export async function startRun(formData: FormData) {
  const { patientId } = runForm.parse({ patientId: field(formData, "patientId") });
  const db = getDb();
  const { actor, session } = await access(patientId);
  if (session) {
    // A launched patient re-runs against the same outside record it was last reconciled with.
    const last = await db.reconciliationRun.findFirst({
      where: { patientId, incomingPatientId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { incomingPatientId: true },
    });
    if (!last?.incomingPatientId || !session.sourceRecordId) redirect("/smart");
    await runReconciliation(db, {
      patientId,
      actor,
      scope: {
        currentSourceRecordId: session.sourceRecordId,
        incomingPatientId: last.incomingPatientId,
      },
    });
  } else await runReconciliation(db, { patientId, actor });
  revalidatePath("/reconcile", "layout");
  redirect(`/reconcile/${patientId}`);
}

export async function decide(formData: FormData) {
  const f = decideForm.parse(
    Object.fromEntries(
      ["patientId", "runId", "itemId", "claimId", "anchor", "action", "note", "edited"].map((k) => [
        k,
        field(formData, k),
      ]),
    ),
  );
  const { actor } = await access(f.patientId);
  const target = f.itemId ? { itemId: f.itemId } : f.claimId ? { claimId: f.claimId } : null;
  let error: string | null = null;
  const ownRun = await getDb().reconciliationRun.count({
    where: { id: f.runId, patientId: f.patientId },
  });
  if (!ownRun) error = "That run does not belong to this patient.";
  else if (!target) error = "Nothing to decide on.";
  else {
    let editedResource: unknown;
    if (f.action === "EDIT") {
      try {
        editedResource = JSON.parse(f.edited ?? "");
      } catch {
        error = "The edited copy is not valid JSON.";
      }
    }
    if (!error) {
      try {
        await recordDecision(getDb(), {
          runId: f.runId,
          target,
          action: f.action,
          actor,
          note: f.note,
          editedResource,
        });
      } catch (e) {
        if (!(e instanceof DecisionError)) throw e;
        error = e.message;
      }
    }
  }
  if (error && f.action === "EDIT" && f.itemId)
    redirect(`/reconcile/${f.patientId}/items/${f.itemId}?error=${encodeURIComponent(error)}`);
  revalidatePath("/reconcile", "layout");
  const query = error ? `?error=${encodeURIComponent(error)}` : "";
  redirect(`/reconcile/${f.patientId}${query}${f.anchor ? `#${f.anchor}` : ""}`);
}
