// Phase 6 roles. Identity is the SMART launch only: the actor is `smart:<fhirUser>`, and its role is a user_roles
// grant if there is one, else PROVIDER for a Practitioner (or PractitionerRole) and VIEWER for anyone else.
import { recordAudit } from "@/audit";
import type { Db } from "@/db";
import { Role } from "@/generated/prisma/enums";

export { Role };
export type RoleName = (typeof Role)[keyof typeof Role];

const RANK: Record<RoleName, number> = { VIEWER: 0, PROVIDER: 1, ADMIN: 2 };

export const allows = (role: RoleName, needed: RoleName) => RANK[role] >= RANK[needed];

/** The role a SMART user has without a grant: provider for a Practitioner or PractitionerRole, else viewer. */
export const defaultRole = (fhirUser: string | null | undefined): RoleName =>
  fhirUser && /(^|\/)(Practitioner|PractitionerRole)\/[A-Za-z0-9\-.]{1,64}$/.test(fhirUser)
    ? Role.PROVIDER
    : Role.VIEWER;

export async function roleOf(
  db: Db,
  user: { actor: string; fhirUser: string | null | undefined },
): Promise<RoleName> {
  const grant = await db.userRole.findUnique({
    where: { actor: user.actor },
    select: { role: true },
  });
  return grant?.role ?? defaultRole(user.fhirUser);
}

/**
 * Demo mode opens the seeded Synthea patients (/demo, /reconcile, /api/transfer) to the fixed demo provider without
 * a login. DEMO_MODE=1|true turns it on and 0|false off; unset, it is on everywhere except a production build.
 */
export function demoMode(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.DEMO_MODE?.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return env.NODE_ENV !== "production";
}

export class RoleError extends Error {
  constructor(
    public readonly needed: RoleName,
    public readonly role: RoleName | null,
  ) {
    super(
      role
        ? `This needs the ${needed.toLowerCase()} role; you have ${role.toLowerCase()}.`
        : "Launch MediSync from your EHR to continue.",
    );
    this.name = "RoleError";
  }
}

export async function grantRole(
  db: Db,
  input: { actor: string; role: RoleName; by: string },
): Promise<void> {
  if (!input.actor.startsWith("smart:"))
    throw new Error("roles are granted to SMART users (smart:<fhirUser>)");
  await db.$transaction(async (tx) => {
    await tx.userRole.upsert({
      where: { actor: input.actor },
      create: { actor: input.actor, role: input.role, grantedBy: input.by },
      update: { role: input.role, grantedBy: input.by, grantedAt: new Date() },
    });
    await recordAudit(tx, {
      actor: input.by,
      action: "UPDATE",
      entityType: "UserRole",
      entityId: input.actor,
      source: "roles",
      details: { role: input.role },
    });
  });
}

/** Removes a grant, so the user falls back to the default role. Returns false if there was none. */
export async function revokeRole(db: Db, input: { actor: string; by: string }): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.userRole.deleteMany({ where: { actor: input.actor } });
    if (count === 0) return false;
    await recordAudit(tx, {
      actor: input.by,
      action: "DELETE",
      entityType: "UserRole",
      entityId: input.actor,
      source: "roles",
    });
    return true;
  });
}
