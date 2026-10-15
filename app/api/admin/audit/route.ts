// GET /api/admin/audit[?from=ISO&to=ISO]: the audit log as NDJSON, admin role only. The chain is verified first and
// reported on the last line ({"chain": ...}) and in X-Audit-Chain; the export itself is an EXPORT audit entry.
import type { NextRequest } from "next/server";
import { exportAudit } from "@/audit/chain";
import { getDb } from "@/db";
import { requestSession, userOf } from "@/security/access";
import { guarded } from "@/http";
import { limitRequest, RULES } from "@/security/ratelimit";
import { allows, Role } from "@/security/roles";

export const dynamic = "force-dynamic";

const date = (v: string | null) => {
  if (v === null) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const GET = guarded("GET /api/admin/audit", async (req: NextRequest) => {
  const db = getDb();
  const session = await requestSession(db, req);
  const limited = await limitRequest(db, RULES.auditExport, session, req);
  if (limited) return limited;
  const user = await userOf(db, session);
  if (!user)
    return Response.json({ error: "launch MediSync from your EHR first" }, { status: 401 });
  if (!allows(user.role, Role.ADMIN))
    return Response.json({ error: "needs the admin role" }, { status: 403 });
  const from = date(req.nextUrl.searchParams.get("from"));
  const to = date(req.nextUrl.searchParams.get("to"));
  if (from === null || to === null)
    return Response.json({ error: "from and to must be ISO-8601 dates" }, { status: 400 });
  const r = await exportAudit(db, { from, to, actor: user.actor, via: "api" });
  return new Response(r.ndjson, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="medisync-audit-${new Date().toISOString().slice(0, 10)}.ndjson"`,
      "cache-control": "no-store",
      "x-audit-chain": r.check.verified ? "verified" : "broken",
    },
  });
});
