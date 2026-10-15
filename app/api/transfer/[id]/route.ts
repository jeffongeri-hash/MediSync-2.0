// GET /api/transfer/:id: a transfer job's status, counts and fidelity report (never the bundle). Audited as a READ.
import { z } from "zod";
import { authorizeRequest } from "@/access";
import { recordAudit } from "@/audit";
import { getDb } from "@/db";
import { JOB_VIEW } from "@/export/run";
import { rateLimit } from "@/security/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = authorizeRequest(request, "transfer.read");
  if (!access.ok) return Response.json({ error: access.error }, { status: access.status });
  const hit = rateLimit(`transfer:get:${access.key}`, 60, 60_000);
  if (!hit.ok) {
    return Response.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "retry-after": String(hit.retryAfter) } },
    );
  }
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return Response.json({ error: "job not found" }, { status: 404 });
  try {
    const db = getDb();
    const job = await db.transferJob.findUnique({
      where: { id },
      select: JOB_VIEW,
    });
    if (!job) return Response.json({ error: "job not found" }, { status: 404 });
    await recordAudit(db, {
      actor: access.role === "open" ? "api:transfer" : access.role,
      action: "READ",
      patientId: job.patientId,
      entityType: "TransferJob",
      entityId: job.id,
      source: "transfer",
    });
    return Response.json(job);
  } catch (err) {
    console.error("transfer read", err instanceof Error ? err.name : "Error");
    return Response.json({ error: "transfer failed" }, { status: 500 });
  }
}
