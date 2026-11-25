// POST /api/transfer/:id/send {target}: a provider approves dry-run job :id and sends it to a receiving EHR named in
// TRANSFER_TARGETS (loopback test servers only). Returns the new job with its delivery; 422 when it was not
// delivered, 409 when the dry run cannot be sent (already sent, not a successful dry run, unknown target).
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { TransferTargetError } from "@/export/deliver";
import { JOB_VIEW } from "@/export/run";
import { SendError, sendTransfer } from "@/export/send";
import { accessFor, requestSession } from "@/security/access";
import { guarded } from "@/http";
import { limitRequest, RULES } from "@/security/ratelimit";
import { allows, demoMode, Role } from "@/security/roles";

export const dynamic = "force-dynamic";

const body = z.strictObject({ target: z.string().min(1).max(20) });
const notFound = () => Response.json({ error: "job not found" }, { status: 404 });

export const POST = guarded(
  "POST /api/transfer/[id]/send",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const db = getDb();
    const session = await requestSession(db, request);
    const limited = await limitRequest(db, RULES.transferSend, session, request);
    if (limited) return limited;
    if (!session?.authorizedAt && !demoMode())
      return Response.json({ error: "launch MediSync from your EHR first" }, { status: 401 });
    if (!z.uuid().safeParse(id).success) return notFound();
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "expected {target: string}" }, { status: 400 });
    const job = await db.transferJob.findUnique({
      where: { id },
      select: { patient: { select: { id: true, sourceSystem: true } } },
    });
    if (!job) return notFound();
    const access = await accessFor(db, session, job.patient);
    if (!access) return notFound();
    if (!allows(access.role, Role.PROVIDER))
      return Response.json({ error: "needs the provider role" }, { status: 403 });
    try {
      const r = await sendTransfer(db, {
        approvedJobId: id,
        target: parsed.data.target,
        actor: access.actor,
      });
      const sent = await db.transferJob.findUniqueOrThrow({
        where: { id: r.jobId },
        select: JOB_VIEW,
      });
      return Response.json(sent, { status: r.delivered ? 200 : 422 });
    } catch (err) {
      if (err instanceof SendError) return Response.json({ error: err.message }, { status: 409 });
      if (err instanceof TransferTargetError)
        return Response.json({ error: err.message }, { status: 503 });
      throw err;
    }
  },
);
