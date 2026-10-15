// Who may act on a patient, and as whom. Pages and actions get the session from next/headers (src/smart/next.ts);
// route handlers from their request. Both end here.
import type { NextRequest } from "next/server";
import type { Db } from "@/db";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import { allows, demoMode, Role, RoleError, roleOf, type RoleName } from "@/security/roles";
import { actorOf } from "@/smart/launch";
import { findSession, SESSION_COOKIE, type SmartSession } from "@/smart/session";

/** The fixed actor for the seeded Synthea patients in demo mode (no login). */
export const DEMO_ACTOR = "demo:provider";

export type Access = { actor: string; role: RoleName; session: SmartSession | null };

/** The user of a completed SMART launch, with their role, or null. */
export async function userOf(db: Db, session: SmartSession | null): Promise<Access | null> {
  if (!session?.authorizedAt) return null;
  const actor = actorOf(session);
  // No verified user (no or failed id_token): read-only, whatever was granted.
  const role = session.fhirUser
    ? await roleOf(db, { actor, fhirUser: session.fhirUser })
    : Role.VIEWER;
  return { actor, role, session };
}

/**
 * A patient read through a SMART launch is reachable only from that launch (its patient context), as the launch's
 * user. Seeded Synthea patients are open to the demo provider, in demo mode only.
 */
export async function accessFor(
  db: Db,
  session: SmartSession | null,
  patient: { id: string; sourceSystem: string },
  env: Record<string, string | undefined> = process.env,
): Promise<Access | null> {
  if (session?.authorizedAt && session.patientId === patient.id) return userOf(db, session);
  return patient.sourceSystem === SYNTHEA_SOURCE && demoMode(env)
    ? { actor: DEMO_ACTOR, role: Role.PROVIDER, session: null }
    : null;
}

/** Throws RoleError unless `access` holds at least `needed`. */
export function requireRole(access: Access | null, needed: RoleName): Access {
  if (!access || !allows(access.role, needed)) throw new RoleError(needed, access?.role ?? null);
  return access;
}

export const requestSession = (db: Db, req: NextRequest) =>
  findSession(db, req.cookies.get(SESSION_COOKIE)?.value);
