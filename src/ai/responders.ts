// Who answers a summary request: the Anthropic API, a recorded response (evals in CI), or a rule-built template
// (no API key). All three return raw JSON text that goes through the same validator.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { AiInput, AiRow } from "@/ai/input";
import { DEFAULT_MODEL, EFFORT, MAX_TOKENS, aiOutputSchema, type AiOutput } from "@/ai/prompt";

export interface AiRequest {
  /** Eval case id; recordings are stored under it. */
  caseId?: string;
  system: string;
  user: string;
  promptVersion: string;
  inputSha256: string;
  input: AiInput;
}
export interface AiResponse {
  responder: Responder["name"];
  model: string | null;
  servedModel: string | null;
  raw: string | null;
  stopReason: string | null;
  /** Why there is no usable output; no PHI. */
  error: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}
export interface Responder {
  name: "anthropic" | "replay" | "template";
  model: string | null;
  respond(req: AiRequest): Promise<AiResponse>;
}

const OUTPUT_FORMAT = betaZodOutputFormat(aiOutputSchema);

function errorCode(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "authentication";
  if (e instanceof Anthropic.PermissionDeniedError) return "permission_denied";
  if (e instanceof Anthropic.RateLimitError) return "rate_limited";
  if (e instanceof Anthropic.BadRequestError) return "bad_request";
  if (e instanceof Anthropic.APIConnectionError) return "connection";
  if (e instanceof Anthropic.APIError) return `api_error:${e.status ?? "unknown"}`;
  if (e instanceof Anthropic.AnthropicError) return "client_error";
  return "unexpected";
}

/**
 * Live Claude call, streamed: structured output against the summary schema, adaptive thinking at a fixed effort, and
 * the server-side refusal fallback ("default" routing), so `servedModel` can differ from `model`.
 */
export function anthropicResponder(
  opts: { model?: string; apiKey?: string; client?: Anthropic } = {},
): Responder {
  const model = opts.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  return {
    name: "anthropic",
    model,
    async respond(req) {
      const base = { responder: "anthropic" as const, model, servedModel: null, usage: null };
      try {
        // Streamed so a long thinking + output turn never hits an HTTP timeout; only the final message is used.
        const res = await client.beta.messages
          .stream({
            model,
            max_tokens: MAX_TOKENS,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { effort: EFFORT, format: OUTPUT_FORMAT },
          })
          .finalMessage();
        const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const stop = res.stop_reason;
        const error =
          stop === "refusal"
            ? `refusal:${res.stop_details?.category ?? "uncategorized"}`
            : stop === "max_tokens"
              ? "max_tokens"
              : text
                ? null
                : "empty_output";
        return {
          ...base,
          servedModel: res.model,
          raw: text || null,
          stopReason: stop,
          error,
          usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
        };
      } catch (e) {
        return { ...base, raw: null, stopReason: null, error: errorCode(e) };
      }
    },
  };
}

export const recordingSchema = z.strictObject({
  caseId: z.string(),
  promptVersion: z.string(),
  inputSha256: z.string(),
  model: z.string().nullable(),
  servedModel: z.string().nullable(),
  stopReason: z.string().nullable(),
  error: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).nullable(),
  recordedAt: z.string(),
  raw: z.string().nullable(),
});
export type Recording = z.infer<typeof recordingSchema>;

/** Replays `<dir>/<caseId>.json`, only for the same prompt version and input hash. */
export function replayResponder(dir: string): Responder {
  return {
    name: "replay",
    model: null,
    async respond(req) {
      const none = {
        responder: "replay" as const,
        model: null,
        servedModel: null,
        raw: null,
        stopReason: null,
        usage: null,
      };
      const file = join(dir, `${req.caseId ?? "unnamed"}.json`);
      if (!existsSync(file)) return { ...none, error: "no_recording" };
      const rec = recordingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (rec.promptVersion !== req.promptVersion || rec.inputSha256 !== req.inputSha256)
        return { ...none, error: "stale_recording" };
      return {
        responder: "replay",
        model: rec.model,
        servedModel: rec.servedModel,
        raw: rec.raw,
        stopReason: rec.stopReason,
        error: rec.error,
        usage: rec.usage,
      };
    },
  };
}

/** Wraps a live responder and writes each answered request to `<dir>/<caseId>.json`. */
export function recordingResponder(
  inner: Responder,
  dir: string,
  now = () => new Date(),
): Responder {
  return {
    ...inner,
    async respond(req) {
      const res = await inner.respond(req);
      if (req.caseId && res.raw !== null) {
        mkdirSync(dir, { recursive: true });
        const rec: Recording = {
          caseId: req.caseId,
          promptVersion: req.promptVersion,
          inputSha256: req.inputSha256,
          model: res.model,
          servedModel: res.servedModel,
          stopReason: res.stopReason,
          error: res.error,
          usage: res.usage,
          recordedAt: now().toISOString(),
          raw: res.raw,
        };
        writeFileSync(join(dir, `${req.caseId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
      }
      return res;
    },
  };
}

const withDate = (label: string, date: string | null) => (date ? `${label} ${date}` : "");

/** One statement per fact, in the records' own words, citing both copies of a paired fact. No AI. */
export function templateOutput(input: AiInput): AiOutput {
  const byId = new Map(input.rows.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const groups: AiRow[][] = [];
  for (const r of input.rows) {
    if (seen.has(r.id)) continue;
    const other = r.same_as ? byId.get(r.same_as) : undefined;
    const group = other ? [r, other] : [r];
    group.forEach((g) => seen.add(g.id));
    groups.push(group);
  }
  const summary: AiOutput["summary"] = [];
  const past = new Map<string, string[]>();
  for (const g of groups) {
    const [first] = g as [AiRow];
    const ids = g.map((r) => r.id);
    const statuses = [...new Set(g.map((r) => r.status ?? "unknown"))];
    const status =
      statuses.length > 1
        ? `${g.map((r) => `${r.status ?? "unknown"} in the ${r.side} record`).join(", ")}`
        : statuses[0]!;
    if (first.list === "problem")
      summary.push({
        topic: "active_problem",
        text: `${first.display}: ${status}${withDate(", onset", first.start)}.`,
        source_ids: ids,
      });
    else if (first.list === "allergy") {
      const reactions = [...new Set(g.flatMap((r) => r.reactions ?? []))];
      summary.push({
        topic: "allergy",
        text: `Allergy: ${first.display}${reactions.length ? ` (reaction: ${reactions.join("; ")})` : ""}, ${status}.`,
        source_ids: ids,
      });
    } else if (first.list === "medication") {
      if (!g.some((r) => r.status === "active")) continue;
      summary.push({
        topic: "medication",
        text: `Medication: ${first.display}, ${status}${withDate(", started", first.start)}.`,
        source_ids: ids,
      });
    } else past.set(first.display, [...(past.get(first.display) ?? []), ...ids]);
  }
  for (const [display, ids] of past)
    summary.push({ topic: "past_history", text: `Past history: ${display}.`, source_ids: ids });
  return { summary, flags: [] };
}

export function templateResponder(): Responder {
  return {
    name: "template",
    model: null,
    async respond(req) {
      return {
        responder: "template",
        model: null,
        servedModel: null,
        raw: JSON.stringify(templateOutput(req.input)),
        stopReason: null,
        error: null,
        usage: null,
      };
    },
  };
}
