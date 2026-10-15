// Role tokens for the transfer API, audit export, and the review UI.
// No tokens configured: local demo and CI stay open (synthetic data). Any token set: every check fails closed.
import { createHash, timingSafeEqual } from "node:crypto";

export const ROLES = ["reviewer", "exporter", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export type Permission = "transfer.read" | "transfer.dryRun" | "transfer.export" | "audit.export";

const GRANTS: Record<Role, readonly Permission[]> = {
  reviewer: ["transfer.read", "transfer.dryRun"],
  exporter: ["transfer.read", "transfer.dryRun", "transfer.export"],
  auditor: ["audit.export"],
};

const TOKEN_ENV: Record<Role, string> = {
  reviewer: "MEDISYNC_REVIEWER_TOKEN",
  exporter: "MEDISYNC_EXPORTER_TOKEN",
  auditor: "MEDISYNC_AUDITOR_TOKEN",
};

export type AccessEnv = Record<string, string | undefined>;

export type AccessGrant = {
  ok: true;
  role: Role | "open";
  /** Stable rate-limit key. Never the token. */
  key: string;
};

export type AccessDenial = { ok: false; status: 401 | 403; error: string };

export function configuredTokens(env: AccessEnv = process.env): { role: Role; token: string }[] {
  return ROLES.flatMap((role) => {
    const token = env[TOKEN_ENV[role]];
    return token ? [{ role, token }] : [];
  });
}

export function accessConfigured(env: AccessEnv = process.env): boolean {
  return configuredTokens(env).length > 0;
}

function sameSecret(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function authorizeToken(
  token: string | undefined,
  permission: Permission,
  env: AccessEnv = process.env,
): AccessGrant | AccessDenial {
  const configured = configuredTokens(env);
  if (configured.length === 0) return { ok: true, role: "open", key: "open" };
  if (!token) return { ok: false, status: 401, error: "authentication required" };
  let role: Role | null = null;
  for (const row of configured) {
    if (sameSecret(token, row.token)) role = row.role;
  }
  if (!role) return { ok: false, status: 401, error: "authentication required" };
  if (!GRANTS[role].includes(permission))
    return { ok: false, status: 403, error: "not allowed for this role" };
  return {
    ok: true,
    role,
    key: createHash("sha256").update(token).digest("hex").slice(0, 16),
  };
}

const COOKIE = "medisync_session";

export function tokenFromRequest(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const bearer = header.slice(7).trim();
    if (bearer) return bearer;
  }
  return cookieValue(request.headers.get("cookie"), COOKIE);
}

export function authorizeRequest(
  request: Request,
  permission: Permission,
  env: AccessEnv = process.env,
): AccessGrant | AccessDenial {
  return authorizeToken(tokenFromRequest(request), permission, env);
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

export { COOKIE as SESSION_COOKIE };
