// POST /api/transfer {patient, dryRun?}: runs one transfer job synchronously and returns its status and fidelity
// report (never the bundle). `patient` is a source Patient.id or an internal id. dryRun defaults to true.
// Reviewer may dry-run. Exporter may store a bundle. Open when no role tokens are set.
import { z } from "zod";
import { authorizeRequest } from "@/access";
import { getDb } from "@/db";
import { JOB_VIEW, PatientNotFoundError, resolvePatient, runTransfer } from "@/export/run";
import { rateLimit } from "@/security/rate-limit";

export const dynamic = "force-dynamic";

const body = z.strictObject({
  patient: z.string().min(1).max(64),
  dryRun: z.boolean().default(true),
});

function limited(accessKey: string) {
  const hit = rateLimit(`transfer:post:${accessKey}`, 20, 60_000);
  if (hit.ok) return null;
  return Response.json(
    { error: "rate limit exceeded" },
    { status: 429, headers: { "retry-after": String(hit.retryAfter) } },
  );
}

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "expected {patient: string, dryRun?: boolean}" },
      { status: 400 },
    );
  }
  const access = authorizeRequest(
    request,
    parsed.data.dryRun ? "transfer.dryRun" : "transfer.export",
  );
  if (!access.ok) return Response.json({ error: access.error }, { status: access.status });
  const wait = limited(access.key);
  if (wait) return wait;
  const db = getDb();
  try {
    const patientId = await resolvePatient(db, parsed.data.patient);
    const r = await runTransfer(db, {
      patientId,
      dryRun: parsed.data.dryRun,
      actor: access.role === "open" ? "api:transfer" : access.role,
    });
    const job = await db.transferJob.findUniqueOrThrow({
      where: { id: r.jobId },
      select: JOB_VIEW,
    });
    return Response.json(job, { status: r.status === "SUCCEEDED" ? 200 : 422 });
  } catch (err) {
    if (err instanceof PatientNotFoundError)
      return Response.json({ error: err.message }, { status: 404 });
    console.error("transfer", err instanceof Error ? err.name : "Error");
    return Response.json({ error: "transfer failed" }, { status: 500 });
  }
}
