"use server";
// Reconcile form actions. Plain <form> posts, so they work without client JS. No authentication until Phase 6:
// decisions are attributed to a fixed demo provider. Nothing here writes canonical rows.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { DecisionError, recordDecision, runReconciliation } from "@/reconcile/run";

const ACTOR = "demo:provider";

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
  await db.patient.findUniqueOrThrow({ where: { id: patientId } });
  await runReconciliation(db, { patientId, actor: ACTOR });
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
  const target = f.itemId ? { itemId: f.itemId } : f.claimId ? { claimId: f.claimId } : null;
  let error: string | null = null;
  if (!target) error = "Nothing to decide on.";
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
          actor: ACTOR,
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
