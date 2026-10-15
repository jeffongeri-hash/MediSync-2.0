// GET /api/transfer/:id: a transfer job's status, counts and fidelity report (never the bundle). Audited as a READ.
// Any role may read a job of a patient it can open; anything else is a 404.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { recordAudit } from "@/audit";
import { JOB_VIEW } from "@/export/run";
import { accessFor, requestSession } from "@/security/access";
import { guarded } from "@/http";
import { limitRequest, RULES } from "@/security/ratelimit";
import { demoMode } from "@/security/roles";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "job not found" }, { status: 404 });

export const GET = guarded(
  "GET /api/transfer/[id]",
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const db = getDb();
    const session = await requestSession(db, request);
    const limited = await limitRequest(db, RULES.transferRead, session, request);
    if (limited) return limited;
    if (!session?.authorizedAt && !demoMode())
      return Response.json({ error: "launch MediSync from your EHR first" }, { status: 401 });
    if (!z.uuid().safeParse(id).success) return notFound();
    const job = await db.transferJob.findUnique({
      where: { id },
      select: { ...JOB_VIEW, patient: { select: { id: true, sourceSystem: true } } },
    });
    if (!job) return notFound();
    const { patient, ...view } = job;
    const access = await accessFor(db, session, patient);
    if (!access) return notFound();
    await recordAudit(db, {
      actor: access.actor,
      action: "READ",
      patientId: job.patientId,
      entityType: "TransferJob",
      entityId: job.id,
      source: "transfer",
    });
    return Response.json(view);
  },
);
