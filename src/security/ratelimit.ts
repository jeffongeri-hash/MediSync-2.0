// Rate limits (Phase 6): fixed windows counted in Postgres, so every app instance shares them. The subject is the
// SMART session when the request has a live one, else the client IP (hashed). The IP comes from X-Forwarded-For only
// with TRUST_PROXY=1 (set it behind a load balancer that overwrites the header); without it, requests with no
// session share one bucket per rule.
import { createHash } from "node:crypto";
import type { Db } from "@/db";
import { log } from "@/log";
import type { SmartSession } from "@/smart/session";

export type Rule = { name: string; limit: number; windowSec: number };

export const RULES = {
  launch: { name: "launch", limit: 20, windowSec: 60 },
  transferRun: { name: "transfer-run", limit: 10, windowSec: 60 },
  transferRead: { name: "transfer-read", limit: 60, windowSec: 60 },
  decide: { name: "decide", limit: 60, windowSec: 60 },
  writeback: { name: "writeback", limit: 60, windowSec: 60 },
  auditExport: { name: "audit-export", limit: 5, windowSec: 60 },
} satisfies Record<string, Rule>;

type Env = Record<string, string | undefined>;

export function subjectOf(
  session: Pick<SmartSession, "id"> | null,
  headers: Headers,
  env: Env = process.env,
): string {
  if (session) return `s:${session.id.slice(0, 32)}`;
  const ip =
    env.TRUST_PROXY === "1" ? headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
  return ip ? `ip:${createHash("sha256").update(ip).digest("hex").slice(0, 32)}` : "ip:unknown";
}

/** Counts one request. Returns null when allowed, else the seconds until the window resets. */
export async function hit(
  db: Db,
  rule: Rule,
  subject: string,
  now = new Date(),
): Promise<number | null> {
  const windowMs = rule.windowSec * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const key = `${rule.name}:${subject}`;
  const [row] = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (key, window_start, count) VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`;
  const count = row?.count ?? 1;
  if (count === 1)
    await db.rateLimit.deleteMany({
      where: { windowStart: { lt: new Date(now.getTime() - 3_600_000) } },
    });
  if (count <= rule.limit) return null;
  const retryAfter = Math.max(
    1,
    Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
  );
  if (count === rule.limit + 1) log("warn", "rate_limited", { route: rule.name, retryAfter });
  return retryAfter;
}

export const tooManyRequests = (retryAfter: number) =>
  Response.json(
    { error: "too many requests", retryAfter },
    { status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" } },
  );

/** Route handlers: a 429 response when the request is over `rule`, else null. */
export async function limitRequest(
  db: Db,
  rule: Rule,
  session: Pick<SmartSession, "id"> | null,
  req: Request,
): Promise<Response | null> {
  const retryAfter = await hit(db, rule, subjectOf(session, req.headers));
  return retryAfter === null ? null : tooManyRequests(retryAfter);
}
