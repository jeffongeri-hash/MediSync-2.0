// Phase 4 eval over the frozen cases in fixtures/eval. Prints a Markdown report (or writes it with --out).
//   pnpm eval                 replay recorded Claude responses (fixtures/eval/recordings); CI reports it
//   pnpm eval --live          call Claude (needs ANTHROPIC_API_KEY) and re-record the cases it runs
//   pnpm eval --template      the rule-built summary, no AI: the key-free Phase 4 gate (CI runs it with --strict)
// Options: --cases case-01,case-11 (subset; a cheap first live run) · --out file · --strict (exit 1 when any
// evaluated case fails) · --prompts dir (write each case's exact system + user prompt and input hash, call nothing).
// Unrecorded or stale cases are reported as not evaluated, never as passed.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport, runEval } from "@/ai/eval";
import { materialize, type EvalCase, type EvalPatient } from "@/ai/eval-cases";
import { prepareInput } from "@/ai/input";
import {
  anthropicResponder,
  recordingResponder,
  replayResponder,
  templateResponder,
  type Responder,
} from "@/ai/responders";
import { summaryRequest } from "@/ai/summarize";
import { buildReconciliation } from "@/reconcile/build";

const arg = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

async function main() {
  const args = process.argv.slice(2);
  const dir = join(process.cwd(), "fixtures/eval");
  const recordings = join(dir, "recordings");
  const patients = JSON.parse(readFileSync(join(dir, "patients.json"), "utf8")) as EvalPatient[];
  const all = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as EvalCase[];
  const wanted = arg(args, "--cases")?.split(",").filter(Boolean);
  const unknown = wanted?.filter((id) => !all.some((c) => c.id === id)) ?? [];
  if (unknown.length > 0) {
    console.error(`eval: unknown case id(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const cases = wanted ? all.filter((c) => wanted.includes(c.id)) : all;

  const promptsDir = arg(args, "--prompts");
  if (promptsDir) {
    mkdirSync(promptsDir, { recursive: true });
    for (const kase of cases) {
      const patient = patients.find((p) => p.key === kase.patient)!;
      const recon = buildReconciliation(materialize(patient, kase), new Date(patient.cutoff));
      const req = summaryRequest(prepareInput(recon), kase.id);
      writeFileSync(
        join(promptsDir, `${kase.id}.txt`),
        `# ${req.promptVersion} · input sha256 ${req.inputSha256}\n\n## system\n\n${req.system}\n\n## user\n\n${req.user}\n`,
      );
    }
    console.log(`eval: wrote ${cases.length} prompt(s) to ${promptsDir}; nothing was sent.`);
    return;
  }

  let responder: Responder;
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
  const out = arg(args, "--out");
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
  if (args.includes("--strict") && report.cases.some((c) => c.status === "fail"))
    process.exitCode = 1;
}

void main();
