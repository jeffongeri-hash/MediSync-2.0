// GET /api/audit: NDJSON of audit_log. Auditor only, once tokens are configured. No clinical text is stored there.
import { AuditAction } from "@/generated/prisma/enums";
import { recordAudit } from "@/audit";
import { auditNdjson, exportAudit } from "@/audit/export";
import { authorizeRequest } from "@/access";
import { getDb } from "@/db";
import { rateLimit } from "@/security/rate-limit";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<string>(Object.values(AuditAction));

function instant(value: string | null): Date | undefined | null {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function GET(request: Request) {
  const access = authorizeRequest(request, "audit.export");
  if (!access.ok) return Response.json({ error: access.error }, { status: access.status });
  const limited = rateLimit(`audit:${access.key}`, 30, 60_000);
  if (!limited.ok) {
    return Response.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "retry-after": String(limited.retryAfter) } },
    );
  }

  const url = new URL(request.url);
  const since = instant(url.searchParams.get("since"));
  const until = instant(url.searchParams.get("until"));
  if (since === null || until === null)
    return Response.json({ error: "since and until must be ISO timestamps" }, { status: 400 });
  const actionParam = url.searchParams.get("action");
  if (actionParam && !ACTIONS.has(actionParam))
    return Response.json({ error: "unknown audit action" }, { status: 400 });
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    return Response.json({ error: "limit must be an integer from 1 to 5000" }, { status: 400 });

  try {
    const db = getDb();
    const rows = await exportAudit(db, {
      since,
      until,
      action: actionParam ? (actionParam as AuditAction) : undefined,
      limit,
    });
    const actor = access.role === "open" ? "api:audit" : access.role;
    await recordAudit(db, {
      actor,
      action: "EXPORT",
      entityType: "AuditLog",
      source: "audit",
      details: { count: rows.length },
    });
    return new Response(auditNdjson(rows), {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    });
  } catch (err) {
    console.error("audit export", err instanceof Error ? err.name : "Error");
    return Response.json({ error: "audit export failed" }, { status: 500 });
  }
}
