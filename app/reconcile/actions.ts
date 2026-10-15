"use server";
// Reconcile form actions. Plain <form> posts, so they work without client JS.
// Decisions are attributed to the signed-in role, or demo:provider when no tokens are set.
// Nothing here writes canonical rows.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { pageActor } from "@/access/session";
import { getDb } from "@/db";
import { DecisionError, recordDecision, runReconciliation } from "@/reconcile/run";
import { rateLimit } from "@/security/rate-limit";

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

async function reviewer() {
  const actor = await pageActor("transfer.dryRun");
  const hit = rateLimit(`reconcile:${actor.key}`, 30, 60_000);
  if (!hit.ok) redirect("/reconcile?error=Too many requests. Wait a minute and try again.");
  return actor.role === "open" ? "demo:provider" : actor.actor;
}

export async function startRun(formData: FormData) {
  const actor = await reviewer();
  const parsed = runForm.safeParse({ patientId: field(formData, "patientId") });
  if (!parsed.success) redirect("/reconcile?error=That patient id is not valid.");
  const db = getDb();
  const patient = await db.patient.findUnique({ where: { id: parsed.data.patientId } });
  if (!patient) redirect("/reconcile?error=Patient not found.");
  await runReconciliation(db, { patientId: parsed.data.patientId, actor });
  revalidatePath("/reconcile", "layout");
  redirect(`/reconcile/${parsed.data.patientId}`);
}

export async function decide(formData: FormData) {
  const actor = await reviewer();
  const parsed = decideForm.safeParse(
    Object.fromEntries(
      ["patientId", "runId", "itemId", "claimId", "anchor", "action", "note", "edited"].map((k) => [
        k,
        field(formData, k),
      ]),
    ),
  );
  if (!parsed.success) redirect("/reconcile?error=That decision could not be read.");
  const f = parsed.data;
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
