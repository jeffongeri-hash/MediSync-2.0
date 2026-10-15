// pnpm roles list | grant <user> <viewer|provider|admin> | revoke <user>
// <user> is a SMART user as audited: `smart:<fhirUser>` (the prefix may be left off). Grants and revokes are
// audited as `cli:<os user>`.
import "dotenv/config";
import { userInfo } from "node:os";
import { createDb } from "@/db";
import { defaultRole, grantRole, revokeRole, Role, type RoleName } from "@/security/roles";

const usage =
  "usage: pnpm roles list | grant <smart:fhirUser> <viewer|provider|admin> | revoke <smart:fhirUser>";
const [cmd, user, roleArg] = process.argv.slice(2);
const actorOf = (u: string) => (u.startsWith("smart:") ? u : `smart:${u}`);
const by = `cli:${userInfo().username}`;

async function main() {
  const db = createDb();
  try {
    if (cmd === "list") {
      const grants = await db.userRole.findMany({ orderBy: { actor: "asc" } });
      const seen = await db.smartSession.findMany({
        where: { authorizedAt: { not: null }, fhirUser: { not: null } },
        distinct: ["fhirUser"],
        select: { fhirUser: true },
      });
      const granted = new Map(grants.map((g) => [g.actor, g]));
      const rows = new Map<string, string>();
      for (const g of grants)
        rows.set(
          g.actor,
          `${g.role.toLowerCase()} (granted by ${g.grantedBy}, ${g.grantedAt.toISOString()})`,
        );
      for (const s of seen) {
        const actor = actorOf(s.fhirUser!);
        if (!granted.has(actor))
          rows.set(actor, `${defaultRole(s.fhirUser).toLowerCase()} (default)`);
      }
      if (rows.size === 0) console.log("No SMART users have launched and no roles are granted.");
      for (const [actor, desc] of [...rows].sort()) console.log(`${actor}\t${desc}`);
      return;
    }
    if (cmd === "grant" && user && roleArg) {
      const role = roleArg.toUpperCase();
      if (!(role in Role)) throw new Error(usage);
      await grantRole(db, { actor: actorOf(user), role: role as RoleName, by });
      console.log(`${actorOf(user)} is now ${role.toLowerCase()}.`);
      return;
    }
    if (cmd === "revoke" && user) {
      const removed = await revokeRole(db, { actor: actorOf(user), by });
      console.log(
        removed
          ? `Grant removed; ${actorOf(user)} has the default role again.`
          : "No grant to remove.",
      );
      return;
    }
    throw new Error(usage);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
