// Runs one transfer job: pnpm transfer <patient> [--dry-run] [--out <dir>] [--report <file>] [--at <instant>]
// <patient> is the internal patient id or the source Patient.id. Writes <out>/<Patient.id>.bundle.json (not on a
// dry run) and the fidelity report (<out>/<Patient.id>.fidelity.md, or --report). --at pins the export timestamp.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "@/db";
import { resolvePatient, runTransfer } from "@/export/run";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    out: { type: "string", default: "exports" },
    report: { type: "string" },
    at: { type: "string" },
  },
});
const db = createDb();

function write(path: string, text: string) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), text);
  console.log(`  wrote ${path}`);
}

async function main() {
  const arg = positionals[0];
  if (!arg)
    throw new Error(
      "usage: pnpm transfer <patient id | source Patient.id> [--dry-run] [--out dir] [--report file] [--at instant]",
    );
  const exportedAt = values.at ? new Date(values.at) : new Date();
  if (Number.isNaN(exportedAt.getTime())) throw new Error("--at must be an ISO 8601 instant");
  const r = await runTransfer(db, {
    patientId: await resolvePatient(db, arg),
    dryRun: values["dry-run"],
    actor: "cli:transfer",
    exportedAt,
  });
  const mode = r.dryRun ? "dry run" : "export";
  const pct = r.completeness === null ? "n/a" : `${(r.completeness * 100).toFixed(1)}%`;
  console.log(
    `transfer ${r.jobId}: ${r.status} (${mode}) · ${r.resourcesExported ?? 0}/${r.resourcesSelected ?? 0} resources · completeness ${pct}` +
      (r.bundleSha256 ? ` · sha256 ${r.bundleSha256.slice(0, 16)}…` : ""),
  );
  const base = join(values.out!, r.patient.sourcePatientId);
  if (r.bundleText) write(`${base}.bundle.json`, r.bundleText);
  if (r.report) write(values.report ?? `${base}.fidelity.md`, r.report);
  if (r.status === "FAILED") throw new Error(r.error ?? "transfer failed");
}

main()
  .catch((err: unknown) => {
    console.error("transfer failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
