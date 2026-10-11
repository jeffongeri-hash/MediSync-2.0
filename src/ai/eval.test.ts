import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderReport, runEval, totals } from "@/ai/eval";
import { buildCases, materialize, reword, type EvalCase, type EvalPatient } from "@/ai/eval-cases";
import {
  replayResponder,
  templateOutput,
  templateResponder,
  type Responder,
} from "@/ai/responders";

const dir = join(process.cwd(), "fixtures/eval");
const patients = JSON.parse(readFileSync(join(dir, "patients.json"), "utf8")) as EvalPatient[];
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as EvalCase[];

describe("eval set", () => {
  it("is 20 cases over 10 synthetic patients, rebuilt identically from the committed rows", () => {
    expect(patients).toHaveLength(10);
    expect(cases).toHaveLength(20);
    expect(buildCases(patients)).toEqual(cases);
    const injected = cases.slice(10).map((c) => c.perturbations.length);
    expect(injected.every((n) => n >= 2 && n <= 3)).toBe(true);
    expect(new Set(cases.flatMap((c) => c.perturbations.map((p) => p.type)))).toEqual(
      new Set(["dose_change", "status_flip", "allergy_med", "recoded_duplicate", "decoy"]),
    );
  });

  it("applies ops without touching the committed rows", () => {
    const kase = cases.find((c) => c.perturbations.some((p) => p.type === "status_flip"))!;
    const patient = patients.find((p) => p.key === kase.patient)!;
    const before = JSON.stringify(patient.rows);
    const rows = materialize(patient, kase);
    expect(JSON.stringify(patient.rows)).toBe(before);
    expect(rows.length).toBeGreaterThanOrEqual(patient.rows.length);
  });

  it("rewords a display into a same-fact variant", () => {
    expect(reword("Essential hypertension (disorder)")).toBe("Hypertension, essential");
    expect(reword("Anemia (disorder)")).toBe("Anemia, unspecified");
  });
});

describe("runEval", () => {
  it("template baseline: every case passes and the rules catch every rule-detectable injection", async () => {
    const report = await runEval(cases, patients, templateResponder());
    const t = totals(report);
    expect(t).toMatchObject({
      evaluated: 20,
      passed: 20,
      unknownIds: 0,
      hallucinated: 0,
      miscited: 0,
    });
    const perts = report.cases.flatMap((c) => c.perturbations);
    for (const p of perts.filter((x) =>
      ["dose_change", "status_flip", "allergy_med"].includes(x.type),
    ))
      expect(p.ruleHit, p.description).toBe(true);
    // A reworded duplicate under a local code is beyond the rules: that is what AI flags are for.
    expect(perts.filter((p) => p.type === "recoded_duplicate").every((p) => !p.ruleHit)).toBe(true);
    expect(perts.some((p) => p.trapped)).toBe(false);
    expect(renderReport(report)).toContain("**Pass rate: 20/20 evaluated (100.0%)");
  });

  it("fails cases whose claims cite unknown ids, name absent conditions or miss citations", async () => {
    const bad: Responder = {
      name: "anthropic",
      model: "bad-model",
      async respond(req) {
        const good = templateOutput(req.input);
        const raw = JSON.stringify({
          summary: [
            ...good.summary,
            {
              topic: "active_problem",
              text: "Type 2 diabetes mellitus.",
              source_ids: [req.input.rows[0]!.id],
            },
            { topic: "past_history", text: "Reviewed.", source_ids: ["C999"] },
            { topic: "past_history", text: "Reviewed.", source_ids: [] },
          ],
          flags: [],
        });
        return {
          responder: "anthropic",
          model: "bad-model",
          servedModel: "bad-model",
          raw,
          stopReason: "end_turn",
          error: null,
          usage: null,
        };
      },
    };
    const report = await runEval(cases.slice(0, 2), patients, bad);
    expect(report.cases.map((c) => c.status)).toEqual(["fail", "fail"]);
    expect(totals(report)).toMatchObject({ unknownIds: 2, uncited: 2 });
    expect(
      report.cases.every(
        (c) => c.hallucinated.includes("diabetes") || c.miscited.includes("diabetes"),
      ),
    ).toBe(true);
  });

  it("reports unrecorded cases as not evaluated rather than passed or failed", async () => {
    const report = await runEval(
      cases.slice(0, 3),
      patients,
      replayResponder(mkdtempSync(join(tmpdir(), "rec-"))),
    );
    expect(report.cases.map((c) => [c.status, c.reason])).toEqual([
      ["not_evaluated", "no_recording"],
      ["not_evaluated", "no_recording"],
      ["not_evaluated", "no_recording"],
    ]);
    expect(totals(report)).toMatchObject({ evaluated: 0, passed: 0 });
  });
});
