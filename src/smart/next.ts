// Next.js glue for the SMART routes and pages: cookies in, redirects out. The launch logic lives in launch.ts.
import { cookies, headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { errorClass, log } from "@/log";
import { accessFor, type Access } from "@/security/access";
import { hit, limitRequest, RULES, subjectOf, type Rule } from "@/security/ratelimit";
import { smartConfig, SmartConfigError, type LaunchKind } from "@/smart/config";
import { beginLaunch, completeLaunch, LaunchError } from "@/smart/launch";
import { findSession, SESSION_COOKIE, type SmartSession } from "@/smart/session";

const toLanding = (base: string, error?: string) =>
  NextResponse.redirect(
    new URL(error ? `/smart?error=${encodeURIComponent(error)}` : "/smart", base),
    303,
  );

const failureCode = (e: unknown) => {
  if (e instanceof LaunchError) return e.code;
  if (e instanceof SmartConfigError) return "config";
  // Class only: messages from the auth or FHIR server can carry URLs with ids.
  log("error", "smart_launch_failed", { errorClass: errorClass(e) });
  return "unexpected";
};

/** GET /smart/launch (EHR launch: iss + launch) and GET /smart/login (standalone, optional iss). */
export async function launchRoute(req: NextRequest, kind: LaunchKind): Promise<Response> {
  const limited = await limitRequest(getDb(), RULES.launch, null, req);
  if (limited) return limited;
  let base = req.nextUrl.origin;
  try {
    const cfg = smartConfig();
    base = new URL(cfg.redirectUri).origin;
    const q = req.nextUrl.searchParams;
    const r = await beginLaunch(getDb(), cfg, {
      kind,
      iss: q.get("iss"),
      server: q.get("server"),
      launch: q.get("launch"),
      secure: cfg.redirectUri.startsWith("https:"),
    });
    const res = NextResponse.redirect(r.location, 302);
    res.headers.append("set-cookie", r.setCookie);
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (e) {
    return toLanding(base, failureCode(e));
  }
}

/** GET /smart/callback: the authorization server's redirect back (code + state, or error). */
export async function callbackRoute(req: NextRequest): Promise<Response> {
  const limited = await limitRequest(getDb(), RULES.launch, null, req);
  if (limited) return limited;
  let base = req.nextUrl.origin;
  try {
    const cfg = smartConfig();
    base = new URL(cfg.redirectUri).origin;
    await completeLaunch(getDb(), cfg, {
      url: req.nextUrl,
      token: req.cookies.get(SESSION_COOKIE)?.value,
    });
    return toLanding(base);
  } catch (e) {
    return toLanding(base, failureCode(e));
  }
}

/** The browser's live SMART session (any state), or null. */
export async function currentSession(): Promise<SmartSession | null> {
  const jar = await cookies();
  return findSession(getDb(), jar.get(SESSION_COOKIE)?.value);
}

/** Who may act on a patient, and as whom (see accessFor). */
export async function patientAccess(patient: { id: string; sourceSystem: string }): Promise<Access | null> {
  return accessFor(getDb(), await currentSession(), patient);
}

/**
 * Server actions: counts one request against `rule` for this browser (its SMART session, else its IP). Returns the
 * seconds to wait when over the limit, else null.
 */
export async function limitAction(rule: Rule, session: SmartSession | null): Promise<number | null> {
  return hit(getDb(), rule, subjectOf(session, await headers()));
}
