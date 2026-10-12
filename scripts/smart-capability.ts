// Records what write-back a SMART FHIR server allows: pnpm smart:capability [iss | --server name] [--out file] [--raw file]
// Reads {iss}/metadata (public, no token) and renders the write-back report. Without an iss it uses the named server,
// else the first configured one. For a known sandbox (Epic, Oracle Health) the report goes to
// docs/reports/phase5-writeback-<source>.md; for any other server (e.g. the test mock) to stdout unless --out is
// given, so a mock can never overwrite a sandbox's record.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderWritebackReport, summarizeCapability } from "@/smart/capability";
import { normalizeIss, serverByName, smartServers, sourceSystemFor } from "@/smart/config";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, raw: { type: "string" }, server: { type: "string" } },
});

function write(path: string, text: string) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), text);
  console.error(`  wrote ${path}`);
}

function pickIss(): string {
  if (positionals[0]) return normalizeIss(positionals[0]);
  const servers = smartServers();
  const server = values.server ? serverByName({ servers }, values.server) : servers[0];
  if (!server) throw new Error(`No configured server named ${values.server}`);
  return server.iss;
}

async function main() {
  const iss = pickIss();
  if (!/^https?:\/\//.test(iss))
    throw new Error("Give an iss (FHIR base URL) or configure SMART servers");
  const res = await fetch(`${iss}/metadata`, { headers: { accept: "application/fhir+json" } });
  if (!res.ok) throw new Error(`GET ${iss}/metadata answered HTTP ${res.status}`);
  const text = await res.text();
  const report = renderWritebackReport(summarizeCapability(JSON.parse(text), iss), new Date());
  if (values.raw) write(values.raw, text);
  const source = sourceSystemFor(iss);
  const sandbox = source === "epic-sandbox" || source === "oracle-sandbox";
  const out = values.out ?? (sandbox ? `docs/reports/phase5-writeback-${source}.md` : undefined);
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
