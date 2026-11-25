"use server";
// Transfer form actions for /demo (Phase 7). Plain <form> posts, as the demo provider in demo mode: a dry run, then
// sending that dry run to a receiving EHR once the provider confirms they read its fidelity report.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db";
import { TransferTargetError } from "@/export/deliver";
import { runTransfer } from "@/export/run";
import { SendError, sendTransfer } from "@/export/send";
import { RULES, type Rule } from "@/security/ratelimit";
import { allows, Role, RoleError } from "@/security/roles";
import { limitAction, patientAccess } from "@/smart/next";

const back = (q: Record<string, string>) => `/demo?${new URLSearchParams(q)}#transfer`;

async function provider(patientId: string, rule: Rule, keep: Record<string, string> = {}) {
  const patient = await getDb().patient.findUniqueOrThrow({
    where: { id: patientId },
    select: { id: true, sourceSystem: true },
  });
  const a = await patientAccess(patient);
  if (!a) redirect(back({ ...keep, transferError: "This patient cannot be opened here." }));
  const wait = await limitAction(rule, a.session);
  if (wait !== null)
    redirect(back({ ...keep, transferError: `Too many requests. Try again in ${wait} seconds.` }));
  if (!allows(a.role, Role.PROVIDER))
    redirect(back({ ...keep, transferError: new RoleError(Role.PROVIDER, a.role).message }));
  return a;
}

const field = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

export async function startDryRun(formData: FormData) {
  const { patientId } = z
    .object({ patientId: z.uuid() })
    .parse({ patientId: field(formData, "patientId") });
  const { actor } = await provider(patientId, RULES.transferRun);
  const r = await runTransfer(getDb(), { patientId, actor, dryRun: true });
  revalidatePath("/demo");
  redirect(back({ transfer: r.jobId }));
}

export async function approveAndSend(formData: FormData) {
  const f = z
    .object({
      jobId: z.uuid(),
      target: z.string().min(1).max(20),
      reviewed: z.literal("yes").optional(),
    })
    .parse({
      jobId: field(formData, "jobId"),
      target: field(formData, "target"),
      reviewed: field(formData, "reviewed"),
    });
  const keep = { transfer: f.jobId };
  if (!f.reviewed)
    redirect(back({ ...keep, transferError: "Confirm that you read the fidelity report first." }));
  const job = await getDb().transferJob.findUniqueOrThrow({
    where: { id: f.jobId },
    select: { patientId: true },
  });
  const { actor } = await provider(job.patientId, RULES.transferSend, keep);
  let sentId: string;
  try {
    sentId = (await sendTransfer(getDb(), { approvedJobId: f.jobId, target: f.target, actor }))
      .jobId;
  } catch (err) {
    if (!(err instanceof SendError || err instanceof TransferTargetError)) throw err;
    redirect(back({ ...keep, transferError: err.message }));
  }
  revalidatePath("/demo");
  redirect(back({ ...keep, sent: sentId }));
}
