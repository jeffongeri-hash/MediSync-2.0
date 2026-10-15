"use server";
// Starts a reconciliation inside a SMART launch: the current chart is what the EHR returned at launch, incoming is
// the synthetic outside record (a seeded Synthea C-CDA) the provider picked. Nothing is written to the EHR.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import { runReconciliation } from "@/reconcile/run";
import { userOf } from "@/security/access";
import { allows, Role } from "@/security/roles";
import { RULES } from "@/security/ratelimit";
import { currentSession, limitAction } from "@/smart/next";

export async function startSmartRun(formData: FormData) {
  const picked = z.uuid().safeParse(formData.get("incomingPatientId"));
  const session = await currentSession();
  if (!session?.authorizedAt || !session.patientId || !session.sourceRecordId)
    redirect("/smart?error=no_session");
  if ((await limitAction(RULES.decide, session)) !== null) redirect("/smart?error=rate_limited");
  const db = getDb();
  const user = await userOf(db, session);
  if (!user || !allows(user.role, Role.PROVIDER)) redirect("/smart?error=forbidden");
  if (!picked.success) redirect("/smart?error=outside_record");
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
    actor: user.actor,
    scope: { currentSourceRecordId: session.sourceRecordId, incomingPatientId: outside.id },
  });
  revalidatePath("/smart");
  redirect(`/reconcile/${session.patientId}`);
}
