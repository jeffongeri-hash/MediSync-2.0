// Next.js glue for the SMART routes and pages: cookies in, redirects out. The launch logic lives in launch.ts.
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import { smartConfig, SmartConfigError, type LaunchKind } from "@/smart/config";
import { actorOf, beginLaunch, completeLaunch, LaunchError } from "@/smart/launch";
import { findSession, SESSION_COOKIE, type SmartSession } from "@/smart/session";

/** Phase 4 demo actor for the seeded Synthea patients (no authentication until Phase 6). */
export const DEMO_ACTOR = "demo:provider";

const toLanding = (base: string, error?: string) =>
  NextResponse.redirect(
    new URL(error ? `/smart?error=${encodeURIComponent(error)}` : "/smart", base),
    303,
  );

const failureCode = (e: unknown) => {
  if (e instanceof LaunchError) return e.code;
  if (e instanceof SmartConfigError) return "config";
  // Class only: messages from the auth or FHIR server can carry URLs with ids.
  console.error("smart launch failed:", e instanceof Error ? e.name : typeof e);
  return "unexpected";
};

/** GET /smart/launch (EHR launch: iss + launch) and GET /smart/login (standalone, optional iss). */
export async function launchRoute(req: NextRequest, kind: LaunchKind): Promise<NextResponse> {
  let base = req.nextUrl.origin;
  try {
    const cfg = smartConfig();
    base = new URL(cfg.redirectUri).origin;
    const q = req.nextUrl.searchParams;
    const r = await beginLaunch(getDb(), cfg, {
      kind,
      iss: q.get("iss"),
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
export async function callbackRoute(req: NextRequest): Promise<NextResponse> {
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

/**
 * Who may act on a patient, and as whom. Seeded Synthea patients stay open to the demo provider. A patient read
 * through a SMART launch is reachable only from that launch (its patient context), acting as the launch's fhirUser.
 */
export async function patientAccess(patient: {
  id: string;
  sourceSystem: string;
}): Promise<{ actor: string; session: SmartSession | null } | null> {
  const session = await currentSession();
  const launched = session?.authorizedAt && session.patientId === patient.id ? session : null;
  if (launched) return { actor: actorOf(launched), session: launched };
  return patient.sourceSystem === SYNTHEA_SOURCE ? { actor: DEMO_ACTOR, session: null } : null;
}
