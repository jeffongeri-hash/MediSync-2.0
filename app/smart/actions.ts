"use server";
// Starts a reconciliation inside a SMART launch: the current chart is what the EHR returned at launch, incoming is
// the synthetic outside record (a seeded Synthea C-CDA) the provider picked. Nothing is written to the EHR.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import { runReconciliation } from "@/reconcile/run";
import { actorOf } from "@/smart/launch";
import { currentSession } from "@/smart/next";

export async function startSmartRun(formData: FormData) {
  const picked = z.uuid().safeParse(formData.get("incomingPatientId"));
  const session = await currentSession();
  if (!session?.authorizedAt || !session.patientId || !session.sourceRecordId)
    redirect("/smart?error=no_session");
  if (!picked.success) redirect("/smart?error=outside_record");
  const db = getDb();
  const outside = await db.patient.findFirst({
    where: {
      id: picked.data,
      sourceSystem: SYNTHEA_SOURCE,
      sourceRecords: { some: { format: "CCDA" } },
    },
    select: { id: true },
  });
  if (!outside) redirect("/smart?error=outside_record");
  await runReconciliation(db, {
    patientId: session.patientId,
    actor: actorOf(session),
    scope: { currentSourceRecordId: session.sourceRecordId, incomingPatientId: outside.id },
  });
  revalidatePath("/smart");
  redirect(`/reconcile/${session.patientId}`);
}
