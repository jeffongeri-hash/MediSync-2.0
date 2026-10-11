// Phase 4 eval over the frozen cases in fixtures/eval. Prints a Markdown report (or writes it with --out).
//   pnpm eval              replay recorded Claude responses (fixtures/eval/recordings); CI runs this
//   pnpm eval --live       call Claude (needs ANTHROPIC_API_KEY) and re-record every case
//   pnpm eval --template   the rule-built template, no AI: checks the harness itself
// Exit code 1 when any evaluated case fails. Unrecorded or stale cases are reported as not evaluated.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport, runEval } from "@/ai/eval";
import type { EvalCase, EvalPatient } from "@/ai/eval-cases";
import {
  anthropicResponder,
  recordingResponder,
  replayResponder,
  templateResponder,
} from "@/ai/responders";

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  const dir = join(process.cwd(), "fixtures/eval");
  const recordings = join(dir, "recordings");
  const patients = JSON.parse(readFileSync(join(dir, "patients.json"), "utf8")) as EvalPatient[];
  const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as EvalCase[];

  let responder;
  if (args.includes("--live")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("eval --live needs ANTHROPIC_API_KEY (see .env.example).");
      process.exit(2);
    }
    responder = recordingResponder(anthropicResponder(), recordings);
  } else if (args.includes("--template")) responder = templateResponder();
  else responder = replayResponder(recordings);

  const report = await runEval(cases, patients, responder);
  const md = renderReport(report);
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
  if (report.cases.some((c) => c.status === "fail")) process.exitCode = 1;
}

void main();
