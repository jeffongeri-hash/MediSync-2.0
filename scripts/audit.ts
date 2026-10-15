// pnpm audit:verify                                   checks the audit_log hash chain; exit 1 if it is broken
// pnpm audit:export [--from ISO] [--to ISO] [--out f]  NDJSON export (verified first; the export is audited)
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { exportAudit, verifyAuditLog } from "@/audit/chain";
import { createDb } from "@/db";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, to: { type: "string" }, out: { type: "string" } },
});
const date = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`--${name} is not a date: ${v}`);
  return d;
};

async function main() {
  const db = createDb();
  try {
    if (positionals[0] === "verify") {
      const c = await verifyAuditLog(db);
      console.log(
        c.verified
          ? `audit chain verified: ${c.rows} rows, head ${c.head ?? "(empty)"}`
          : `audit chain BROKEN at row ${c.broken!.id} (${c.broken!.reason}); ${c.rows} rows checked`,
      );
      if (!c.verified) process.exitCode = 1;
      return;
    }
    if (positionals[0] === "export") {
      const r = await exportAudit(db, {
        from: date(values.from, "from"),
        to: date(values.to, "to"),
        actor: `cli:${userInfo().username}`,
        via: "cli",
      });
      if (values.out) {
        writeFileSync(values.out, r.ndjson);
        console.error(
          `audit:export: ${r.exported} rows to ${values.out}; chain ${r.check.verified ? "verified" : "BROKEN"}`,
        );
      } else process.stdout.write(r.ndjson);
      if (!r.check.verified) process.exitCode = 1;
      return;
    }
    throw new Error(
      "usage: pnpm audit:verify | pnpm audit:export [--from ISO] [--to ISO] [--out file]",
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
