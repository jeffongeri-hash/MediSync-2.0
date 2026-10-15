// GET /smart/writeback/:runId: the dry-run write-back package for a run of the launched patient, as a JSON download.
// It is never sent to the EHR. The download itself is an EXPORT audit entry.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { recordAudit } from "@/audit";
import { getDb } from "@/db";
import type { CapabilitySummary } from "@/smart/capability";
import { requestSession, userOf } from "@/security/access";
import { guarded } from "@/http";
import { limitRequest, RULES } from "@/security/ratelimit";
import { allows, Role } from "@/security/roles";
import { buildWritePackage, loadWriteItems } from "@/smart/writeback";

export const dynamic = "force-dynamic";

export const GET = guarded(
  "GET /smart/writeback/[runId]",
  async (req: NextRequest, { params }: { params: Promise<{ runId: string }> }) => {
    const { runId } = await params;
    const db = getDb();
    const session = await requestSession(db, req);
    const limited = await limitRequest(db, RULES.writeback, session, req);
    if (limited) return limited;
    if (!z.uuid().safeParse(runId).success || !session?.authorizedAt || !session.patientId)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    const user = await userOf(db, session);
    if (!user || !allows(user.role, Role.PROVIDER))
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const run = await db.reconciliationRun.findFirst({
      where: { id: runId, patientId: session.patientId },
      select: { id: true },
    });
    if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const capability =
      ((session.fetchSummary ?? {}) as { capability?: CapabilitySummary | null }).capability ??
      null;
    const pkg = buildWritePackage({
      runId,
      items: await loadWriteItems(db, runId),
      capability,
      fhirPatientId: session.fhirPatientId ?? "",
      now: new Date(),
    });
    await recordAudit(db, {
      actor: user.actor,
      action: "EXPORT",
      patientId: session.patientId,
      entityType: "ReconciliationRun",
      entityId: runId,
      source: "writeback-dry-run",
      details: { candidates: pkg.candidates.length, viaFhir: pkg.bundle.entry.length, sent: false },
    });
    return new NextResponse(JSON.stringify(pkg, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="writeback-dry-run-${runId}.json"`,
        "cache-control": "no-store",
      },
    });
  },
);
