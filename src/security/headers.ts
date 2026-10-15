// Response security headers (Phase 6), set by proxy.ts on every page and API response. Embedding: the app opens
// inside an EHR, so frame-ancestors allows 'self' plus each configured EHR's origins (SMART_<NAME>_FRAME_ANCESTORS,
// or SMART_FRAME_ANCESTORS in the single-server form; default: the origin of the server's iss). No X-Frame-Options:
// it cannot name allowed hosts, and the CSP takes precedence in every current browser.
import { serverVar, smartServers } from "@/smart/config";

type Env = Record<string, string | undefined>;

const ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/** The EHR origins allowed to frame the app. A malformed origin is left out, never widened. */
export function frameAncestors(env: Env = process.env): string[] {
  let servers;
  try {
    servers = smartServers(env);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const s of servers) {
    const set = env.SMART_SERVERS?.trim()
      ? env[serverVar(s.name, "FRAME_ANCESTORS")]
      : env.SMART_FRAME_ANCESTORS;
    const list = set?.trim() ? set.trim().split(/[\s,]+/) : [new URL(s.iss).origin];
    for (const o of list.map((v) => v.toLowerCase().replace(/\/+$/, "")))
      if (ORIGIN.test(o) || LOCAL.test(o)) out.add(o);
  }
  return [...out].sort();
}

export function contentSecurityPolicy(opts: { nonce: string; dev: boolean; ancestors: string[] }) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${opts.nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    // Dev injects <style> tags; production CSS is linked from 'self'. Fonts come from Google Fonts (app/layout.tsx).
    `style-src 'self' ${opts.dev ? "'unsafe-inline'" : `'nonce-${opts.nonce}'`} https://fonts.googleapis.com`,
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${["'self'", ...opts.ancestors].join(" ")}`,
  ].join("; ");
}

export function securityHeaders(opts: { csp: string; https: boolean }): Record<string, string> {
  return {
    "content-security-policy": opts.csp,
    "x-content-type-options": "nosniff",
    // Launch and callback URLs carry `launch`, `code` and `state`: never send them on as a Referer.
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "cross-origin-resource-policy": "same-origin",
    ...(opts.https ? { "strict-transport-security": "max-age=63072000; includeSubDomains" } : {}),
  };
}
