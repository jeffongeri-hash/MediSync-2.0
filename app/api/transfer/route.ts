// POST /api/transfer {patient, dryRun?}: runs one transfer job synchronously and returns its status and fidelity
// report (never the bundle). `patient` is a source Patient.id or an internal id. dryRun defaults to true.
// Needs the provider role: a SMART session for that patient, or a seeded patient in demo mode.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { JOB_VIEW, PatientNotFoundError, resolvePatient, runTransfer } from "@/export/run";
import { accessFor, requestSession } from "@/security/access";
import { allows, demoMode, Role } from "@/security/roles";

export const dynamic = "force-dynamic";

const body = z.strictObject({
  patient: z.string().min(1).max(64),
  dryRun: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  const db = getDb();
  const session = await requestSession(db, request);
  if (!session?.authorizedAt && !demoMode())
    return Response.json({ error: "launch MediSync from your EHR first" }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "expected {patient: string, dryRun?: boolean}" },
      { status: 400 },
    );
  }
  try {
    const patientId = await resolvePatient(db, parsed.data.patient);
    const patient = await db.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: { id: true, sourceSystem: true },
    });
    const access = await accessFor(db, session, patient);
    if (!access) throw new PatientNotFoundError(parsed.data.patient);
    if (!allows(access.role, Role.PROVIDER))
      return Response.json({ error: "needs the provider role" }, { status: 403 });
    const r = await runTransfer(db, {
      patientId,
      dryRun: parsed.data.dryRun,
      actor: access.actor,
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
