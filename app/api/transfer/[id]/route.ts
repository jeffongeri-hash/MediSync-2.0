// GET /api/transfer/:id: a transfer job's status, counts and fidelity report (never the bundle). Audited as a READ.
import { z } from "zod";
import { getDb } from "@/db";
import { recordAudit } from "@/audit";
import { JOB_VIEW } from "@/export/run";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return Response.json({ error: "job not found" }, { status: 404 });
  const db = getDb();
  const job = await db.transferJob.findUnique({
    where: { id },
    select: JOB_VIEW,
  });
  if (!job) return Response.json({ error: "job not found" }, { status: 404 });
  await recordAudit(db, {
    actor: "api:transfer",
    action: "READ",
    patientId: job.patientId,
    entityType: "TransferJob",
    entityId: job.id,
    source: "transfer",
  });
  return Response.json(job);
}
