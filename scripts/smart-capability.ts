// Records what write-back a SMART FHIR server allows: pnpm smart:capability [iss] [--out file] [--raw file]
// Reads {iss}/metadata (public, no token) and renders the write-back report. iss defaults to the first SMART_ISS.
// For the Epic sandbox the report goes to docs/reports/phase5-writeback.md; for any other server (e.g. the test mock)
// to stdout unless --out is given, so a mock can never overwrite the Epic record.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderWritebackReport, summarizeCapability } from "@/smart/capability";
import { normalizeIss, sourceSystemFor } from "@/smart/config";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, raw: { type: "string" } },
});

function write(path: string, text: string) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), text);
  console.error(`  wrote ${path}`);
}

async function main() {
  const iss = normalizeIss(positionals[0] ?? (process.env.SMART_ISS ?? "").split(",")[0] ?? "");
  if (!/^https?:\/\//.test(iss)) throw new Error("Give an iss (FHIR base URL) or set SMART_ISS");
  const res = await fetch(`${iss}/metadata`, { headers: { accept: "application/fhir+json" } });
  if (!res.ok) throw new Error(`GET ${iss}/metadata answered HTTP ${res.status}`);
  const text = await res.text();
  const report = renderWritebackReport(summarizeCapability(JSON.parse(text), iss), new Date());
  if (values.raw) write(values.raw, text);
  const out =
    values.out ??
    (sourceSystemFor(iss) === "epic-sandbox" ? "docs/reports/phase5-writeback.md" : undefined);
  if (out) write(out, report);
  else process.stdout.write(report);
}

main().catch((e: unknown) => {
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  console.error(
    `smart:capability failed: ${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause})` : ""}`,
  );
  process.exit(1);
});
