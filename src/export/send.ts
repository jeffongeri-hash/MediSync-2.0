// Sending an approved dry run to a receiving EHR (Phase 7). A provider approves a dry-run job after reading its
// fidelity report; this re-runs the transfer at the dry run's exportedAt (same canonical rows -> same bytes) and sends
// only if the bundle hashes the same as the one approved. One approval sends at most once: approved_job_id is unique
// and is claimed before anything is sent. Every attempt is an EXPORT audit entry, whether or not it was delivered.
import { recordAudit } from "@/audit";
import type { Db } from "@/db";
import {
  postTransaction,
  transferTargets,
  type Delivery,
  type TransferTarget,
} from "@/export/deliver";
import { runTransfer } from "@/export/run";

/** The request cannot be acted on (unknown target, not an approvable dry run, already sent). Nothing was sent. */
export class SendError extends Error {}

export type SendResult = {
  jobId: string;
  delivered: boolean;
  target: string;
  delivery: Delivery | null;
  error: string | null;
};

const ALREADY_SENT = "this dry run was already sent; run a new dry run to send again";

export async function sendTransfer(
  db: Db,
  {
    approvedJobId,
    target: targetName,
    actor,
    targets = transferTargets(),
    fetchFn,
  }: {
    approvedJobId: string;
    target: string;
    actor: string;
    targets?: TransferTarget[];
    fetchFn?: typeof fetch;
  },
): Promise<SendResult> {
  const target = targets.find((t) => t.name === targetName);
  if (!target) throw new SendError("unknown transfer target");
  const approved = await db.transferJob.findUnique({
    where: { id: approvedJobId },
    select: { patientId: true, dryRun: true, status: true, bundleSha256: true, exportedAt: true },
  });
  if (!approved) throw new SendError("dry run not found");
  if (
    !approved.dryRun ||
    approved.status !== "SUCCEEDED" ||
    !approved.bundleSha256 ||
    !approved.exportedAt
  )
    throw new SendError("only a successful dry run can be approved for sending");
  if (await db.transferJob.count({ where: { approvedJobId } })) throw new SendError(ALREADY_SENT);

  const run = await runTransfer(db, {
    patientId: approved.patientId,
    actor,
    exportedAt: approved.exportedAt,
  });
  try {
    await db.transferJob.update({
      where: { id: run.jobId },
      data: { approvedJobId, target: target.name },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new SendError(ALREADY_SENT);
    throw err;
  }

  let delivery: Delivery | null = null;
  let error: string | null = null;
  if (run.status !== "SUCCEEDED" || !run.bundleText)
    error = run.error ?? "the transfer did not produce a bundle";
  else if (run.bundleSha256 !== approved.bundleSha256)
    error = "the record changed after the dry run was approved; run a new dry run";
  else {
    delivery = await postTransaction(target, run.bundleText, fetchFn ? { fetchFn } : {});
    error = delivery.error;
  }
  await db.$transaction(async (tx) => {
    await tx.transferJob.update({
      where: { id: run.jobId },
      data: {
        deliveredAt: error ? null : new Date(),
        delivery: delivery ?? { httpStatus: null, created: {}, targetPatientId: null, error },
      },
    });
    await recordAudit(tx, {
      actor,
      action: "EXPORT",
      patientId: approved.patientId,
      entityType: "TransferJob",
      entityId: run.jobId,
      source: "transfer:send",
      details: {
        target: target.name,
        approvedJobId,
        bundleSha256: run.bundleSha256,
        delivered: !error,
        httpStatus: delivery?.httpStatus ?? null,
        created: delivery ? Object.values(delivery.created).reduce((a, b) => a + b, 0) : 0,
        error,
      },
    });
  });
  return { jobId: run.jobId, delivered: !error, target: target.name, delivery, error };
}
