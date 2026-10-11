// POST /api/transfer {patient, dryRun?}: runs one transfer job synchronously and returns its status and fidelity
// report (never the bundle). `patient` is a source Patient.id or an internal id. dryRun defaults to true.
// No authentication yet: synthetic data only, role-based access is Phase 6.
import { z } from "zod";
import { getDb } from "@/db";
import { JOB_VIEW, PatientNotFoundError, resolvePatient, runTransfer } from "@/export/run";

export const dynamic = "force-dynamic";

const body = z.strictObject({
  patient: z.string().min(1).max(64),
  dryRun: z.boolean().default(true),
});

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "expected {patient: string, dryRun?: boolean}" },
      { status: 400 },
    );
  }
  const db = getDb();
  try {
    const patientId = await resolvePatient(db, parsed.data.patient);
    const r = await runTransfer(db, {
      patientId,
      dryRun: parsed.data.dryRun,
      actor: "api:transfer",
    });
    const job = await db.transferJob.findUniqueOrThrow({
      where: { id: r.jobId },
      select: JOB_VIEW,
    });
    return Response.json(job, { status: r.status === "SUCCEEDED" ? 200 : 422 });
  } catch (err) {
    if (err instanceof PatientNotFoundError)
      return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
