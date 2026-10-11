// Phase 4 eval: run each case through rules + summary, then score. A case passes when the output parsed, has at
// least one claim, and every claim is valid: at least one citation, every cited id in the input, and no condition
// that is missing from the records (hallucinated) or from the cited rows (miscited). Flag recall is reported too.
import type { Responder } from "@/ai/responders";
import { summarize } from "@/ai/summarize";
import {
  materialize,
  type EvalCase,
  type EvalPatient,
  type PerturbationType,
} from "@/ai/eval-cases";
import { PROMPT_VERSION } from "@/ai/prompt";
import { buildReconciliation, distinctFlags } from "@/reconcile/build";

export interface PerturbationResult {
  type: PerturbationType;
  description: string;
  /** A rule flag with the expected code cites exactly the expected rows. */
  ruleHit: boolean;
  /** A valid AI flag cites every expected row. */
  aiHit: boolean;
  /** Decoys: some claim named the trap condition. */
  trapped: boolean;
}
export interface CaseResult {
  id: string;
  patient: string;
  status: "pass" | "fail" | "not_evaluated";
  reason: string | null;
  servedModel: string | null;
  claims: number;
  validClaims: number;
  citations: number;
  unknownIds: number;
  uncited: number;
  hallucinated: string[];
  miscited: string[];
  perturbations: PerturbationResult[];
}
export interface EvalReport {
  responder: string;
  model: string | null;
  promptVersion: string;
  ranAt: string;
  cases: CaseResult[];
}

/** Errors that mean "no recorded answer to score", as opposed to a model failure. */
const NOT_EVALUATED = new Set(["no_recording", "stale_recording"]);

export async function runCase(
  kase: EvalCase,
  patient: EvalPatient,
  responder: Responder,
): Promise<CaseResult> {
  const recon = buildReconciliation(materialize(patient, kase), new Date(patient.cutoff));
  const s = await summarize(recon, responder, kase.id);
  const claims = s.checked.claims;
  const problems = claims.flatMap((c) => c.problems);
  const ofKind = (prefix: string) =>
    problems.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  const ruleFlags = distinctFlags(recon.items);
  const aiFlags = claims.filter((c) => c.kind === "FLAG" && c.valid);
  const perturbations = kase.perturbations.map((p) => {
    const want = [...p.expect.sourceIds].sort().join(",");
    return {
      type: p.type,
      description: p.description,
      ruleHit:
        p.expect.flag !== null &&
        ruleFlags.some(
          (f) => f.code === p.expect.flag && [...f.sourceIds].sort().join(",") === want,
        ),
      aiHit:
        p.expect.flag !== null &&
        aiFlags.some((f) => p.expect.sourceIds.every((id) => f.sourceIds.includes(id))),
      trapped:
        !!p.expect.trap &&
        claims.some((c) => c.problems.some((x) => x.endsWith(`:${p.expect.trap}`))),
    };
  });
  const error = s.checked.error;
  const status: CaseResult["status"] =
    error && NOT_EVALUATED.has(error)
      ? "not_evaluated"
      : !error && claims.length > 0 && claims.every((c) => c.valid)
        ? "pass"
        : "fail";
  return {
    id: kase.id,
    patient: kase.patient,
    status,
    reason: error ?? (claims.length === 0 ? "no_claims" : null),
    servedModel: s.response.servedModel,
    claims: claims.length,
    validClaims: claims.filter((c) => c.valid).length,
    citations: claims.reduce((n, c) => n + c.citedAliases.length, 0),
    unknownIds: ofKind("unknown_id:").length,
    uncited: problems.filter((p) => p === "no_source").length,
    hallucinated: ofKind("hallucinated_condition:"),
    miscited: ofKind("miscited_condition:"),
    perturbations,
  };
}

export async function runEval(
  cases: EvalCase[],
  patients: EvalPatient[],
  responder: Responder,
  now = new Date(),
): Promise<EvalReport> {
  const byKey = new Map(patients.map((p) => [p.key, p]));
  const results: CaseResult[] = [];
  for (const kase of cases) {
    const patient = byKey.get(kase.patient);
    if (!patient) throw new Error(`${kase.id}: unknown patient ${kase.patient}`);
    results.push(await runCase(kase, patient, responder));
  }
  return {
    responder: responder.name,
    model: responder.model,
    promptVersion: PROMPT_VERSION,
    ranAt: now.toISOString(),
    cases: results,
  };
}

export function totals(report: EvalReport) {
  const evaluated = report.cases.filter((c) => c.status !== "not_evaluated");
  const sum = (f: (c: CaseResult) => number) => evaluated.reduce((n, c) => n + f(c), 0);
  return {
    cases: report.cases.length,
    evaluated: evaluated.length,
    passed: evaluated.filter((c) => c.status === "pass").length,
    claims: sum((c) => c.claims),
    validClaims: sum((c) => c.validClaims),
    citations: sum((c) => c.citations),
    unknownIds: sum((c) => c.unknownIds),
    uncited: sum((c) => c.uncited),
    hallucinated: sum((c) => c.hallucinated.length),
    miscited: sum((c) => c.miscited.length),
  };
}

const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`);

export function renderReport(report: EvalReport): string {
  const t = totals(report);
  const perts = report.cases
    .filter((c) => c.status !== "not_evaluated")
    .flatMap((c) => c.perturbations);
  const types = [...new Set(perts.map((p) => p.type))];
  const lines = [
    "# Reconciliation eval",
    "",
    `Responder: ${report.responder}${report.model ? ` (${report.model})` : ""} · prompt ${report.promptVersion} · ${report.ranAt}`,
    "",
    `**Pass rate: ${t.passed}/${t.evaluated} evaluated (${pct(t.passed, t.evaluated)}); ${t.cases - t.evaluated} of ${t.cases} not evaluated.**`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Claims valid | ${t.validClaims}/${t.claims} (${pct(t.validClaims, t.claims)}) |`,
    `| Citations to ids not in the input | ${t.unknownIds} of ${t.citations} |`,
    `| Claims with no citation | ${t.uncited} |`,
    `| Hallucinated conditions (in no record) | ${t.hallucinated} |`,
    `| Miscited conditions (in a record the claim does not cite) | ${t.miscited} |`,
    "",
    "## Injected changes",
    "",
    "| Type | Cases | Caught by rules | Caught by AI flags | Decoy named |",
    "| --- | --- | --- | --- | --- |",
    ...types.map((type) => {
      const ps = perts.filter((p) => p.type === type);
      const n = (f: (p: PerturbationResult) => boolean) => ps.filter(f).length;
      return type === "decoy"
        ? `| ${type} | ${ps.length} | n/a | n/a | ${n((p) => p.trapped)} |`
        : `| ${type} | ${ps.length} | ${n((p) => p.ruleHit)} | ${n((p) => p.aiHit)} | n/a |`;
    }),
    "",
    "## Cases",
    "",
    "| Case | Patient | Injected | Status | Claims valid | Problems |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.cases.map((c) => {
      const problems = [
        c.unknownIds ? `${c.unknownIds} unknown id` : "",
        c.uncited ? `${c.uncited} uncited` : "",
        ...c.hallucinated.map((h) => `hallucinated: ${h}`),
        ...c.miscited.map((m) => `miscited: ${m}`),
        c.reason ?? "",
      ].filter(Boolean);
      return `| ${c.id} | ${c.patient} | ${c.perturbations.map((p) => p.type).join(", ") || "none"} | ${c.status} | ${c.validClaims}/${c.claims} | ${problems.join("; ") || "none"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}
