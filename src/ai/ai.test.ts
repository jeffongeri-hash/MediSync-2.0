import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { conditionMentions } from "@/ai/conditions";
import { prepareInput } from "@/ai/input";
import { PROMPT_VERSION } from "@/ai/prompt";
import {
  anthropicResponder,
  recordingResponder,
  replayResponder,
  templateResponder,
  type Responder,
} from "@/ai/responders";
import { summarize } from "@/ai/summarize";
import { checkOutput } from "@/ai/validate";
import { SYSTEM } from "@/mapping/systems";
import { buildReconciliation } from "@/reconcile/build";
import type { SourceRow } from "@/reconcile/rows";

const CUTOFF = new Date("2025-01-01T00:00:00Z");
const row = (
  id: string,
  format: SourceRow["format"],
  code: string,
  display: string,
  status = "active",
  dupOf: string | null = null,
): SourceRow => ({
  id,
  resourceType: "Condition",
  format,
  duplicateOfId: dupOf,
  codeSystem: SYSTEM.SNOMED,
  code,
  resource: {
    clinicalStatus: { coding: [{ code: status }] },
    code: { coding: [{ system: SYSTEM.SNOMED, code, display }] },
    onsetDateTime: "2020-03-01T10:00:00Z",
  },
});
const recon = buildReconciliation(
  [
    row("a1", "FHIR_BUNDLE", "714628002", "Prediabetes (finding)"),
    row("a2", "CCDA", "714628002", "Prediabetes (finding)", "active", "a1"),
    row("b1", "FHIR_BUNDLE", "233678006", "Childhood asthma (disorder)"),
    row("b2", "CCDA", "233678006", "Childhood asthma (disorder)", "resolved", "b1"),
  ],
  CUTOFF,
);
const prepared = prepareInput(recon);
const alias = (id: string) => [...prepared.aliases].find(([, v]) => v === id)![0];
const out = (summary: { text: string; source_ids: string[] }[], flags: unknown[] = []) =>
  JSON.stringify({ summary: summary.map((s) => ({ topic: "active_problem", ...s })), flags });

describe("prepareInput", () => {
  it("aliases rows C1.. and I1.., links pairs, and lists rule flags by alias", () => {
    expect([...prepared.aliases.keys()].sort()).toEqual(["C1", "C2", "I1", "I2"]);
    expect(prepared.input.rows.find((r) => r.id === alias("b2"))).toMatchObject({
      side: "incoming",
      same_as: alias("b1"),
      status: "resolved",
    });
    expect(prepared.input.rule_flags).toEqual([
      expect.objectContaining({ code: "status_conflict", rows: [alias("b1"), alias("b2")] }),
    ]);
    expect(JSON.stringify(prepared.input)).not.toMatch(/"a1"|"b2"/); // canonical ids never reach the prompt
  });
});

describe("checkOutput", () => {
  it("accepts a claim whose conditions are on its cited rows", () => {
    const r = checkOutput(
      out([{ text: "Prediabetes, active since 2020.", source_ids: [alias("a1"), alias("a2")] }]),
      prepared,
    );
    expect(r.error).toBeNull();
    expect(r.claims[0]).toMatchObject({ valid: true, sourceIds: ["a1", "a2"] });
  });

  it("rejects missing and unknown citations", () => {
    const r = checkOutput(
      out([
        { text: "Reviewed.", source_ids: [] },
        { text: "Reviewed.", source_ids: ["C9", alias("b1")] },
        { text: "Reviewed.", source_ids: ["F1"] },
      ]),
      prepared,
    );
    expect(r.claims.map((c) => c.problems)).toEqual([
      ["no_source"],
      ["unknown_id:C9"],
      ["unknown_id:F1"],
    ]);
    expect(r.claims[1]!.sourceIds).toEqual(["b1"]);
  });

  it("separates hallucinated conditions (in no row) from miscited ones (in an uncited row)", () => {
    const r = checkOutput(
      out([
        { text: "Type 2 diabetes mellitus, active.", source_ids: [alias("a1")] },
        { text: "Pre-diabetes and asthma.", source_ids: [alias("a1")] },
        { text: "Hypertension noted.", source_ids: [alias("b1")] },
      ]),
      prepared,
    );
    expect(r.claims.map((c) => c.problems)).toEqual([
      ["hallucinated_condition:diabetes"],
      ["miscited_condition:asthma"],
      ["hallucinated_condition:hypertension"],
    ]);
  });

  it("reports unparseable and off-schema output", () => {
    expect(checkOutput("{nope", prepared).error).toBe("unparseable_json");
    expect(checkOutput(JSON.stringify({ summary: [{ text: "x" }] }), prepared).error).toBe(
      "schema_mismatch",
    );
    expect(checkOutput(null, prepared).error).toBe("no_output");
  });

  it("detects common condition synonyms but not substrings", () => {
    const keys = (t: string) => conditionMentions(t).map((c) => c.key);
    expect(keys("history of high blood pressure")).toContain("hypertension");
    expect(keys("prediabetes")).not.toContain("diabetes");
    expect(keys("pre-diabetes")).not.toContain("diabetes");
    expect(keys("takes albuterol as needed")).toEqual([]);
  });
});

describe("responders", () => {
  it("template output always validates: it uses each row's own wording and cites it", async () => {
    const r = await summarize(recon, templateResponder());
    expect(r.checked.error).toBeNull();
    expect(r.checked.claims.length).toBeGreaterThan(0);
    expect(r.checked.claims.every((c) => c.valid)).toBe(true);
  });

  it("records a live answer and replays it only for the same input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "medisync-rec-"));
    const fake: Responder = {
      name: "anthropic",
      model: "test-model",
      respond: async () => ({
        responder: "anthropic",
        model: "test-model",
        servedModel: "test-model",
        raw: out([{ text: "Prediabetes.", source_ids: ["C1"] }]),
        stopReason: "end_turn",
        error: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
    await summarize(recon, recordingResponder(fake, dir), "case-x");
    const saved = JSON.parse(readFileSync(join(dir, "case-x.json"), "utf8"));
    expect(saved).toMatchObject({
      caseId: "case-x",
      promptVersion: PROMPT_VERSION,
      model: "test-model",
    });

    const replay = await summarize(recon, replayResponder(dir), "case-x");
    expect(replay.response).toMatchObject({ responder: "replay", raw: saved.raw, error: null });
    const other = buildReconciliation(
      [row("z", "CCDA", "233678006", "Childhood asthma (disorder)")],
      CUTOFF,
    );
    expect((await summarize(other, replayResponder(dir), "case-x")).checked.error).toBe(
      "stale_recording",
    );
    expect((await summarize(recon, replayResponder(dir), "case-y")).checked.error).toBe(
      "no_recording",
    );
  });

  it("calls the API with structured output, fixed effort and the refusal fallback, and maps failures", async () => {
    const calls: Record<string, unknown>[] = [];
    const message = (stop: string, text: string) => ({
      model: "claude-sonnet-5-5",
      stop_reason: stop,
      stop_details:
        stop === "refusal" ? { type: "refusal", category: "bio", explanation: null } : null,
      content: text ? [{ type: "text", text }] : [],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    let next: unknown = message(
      "end_turn",
      out([{ text: "Prediabetes.", source_ids: [alias("a1")] }]),
    );
    const client = {
      beta: {
        messages: {
          create: async (params: Record<string, unknown>) => {
            calls.push(params);
            if (next instanceof Error) throw next;
            return next;
          },
        },
      },
    } as unknown as Anthropic;
    const responder = anthropicResponder({ client, model: "claude-sonnet-5-5" });
    const ok = await summarize(recon, responder);
    expect(ok.checked.claims[0]?.valid).toBe(true);
    expect(calls[0]).toMatchObject({
      model: "claude-sonnet-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    expect(calls[0]).not.toHaveProperty("tool_choice");

    next = message("refusal", "");
    expect((await summarize(recon, responder)).checked.error).toBe("refusal:bio");
    next = new Anthropic.APIConnectionError({ message: "down" });
    expect((await summarize(recon, responder)).checked.error).toBe("connection");
  });
});
