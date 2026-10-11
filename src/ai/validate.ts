// Checks a model (or template) output against the input it was given. A claim is valid only when it cites at least
// one record, every cited id was in the input, and every condition it names is on a cited row. Invalid claims are
// kept with their reasons (for audit and evals) and never shown as suggestions.
import { conditionMentions, supports } from "@/ai/conditions";
import type { PreparedInput } from "@/ai/input";
import { aiOutputSchema, type AiOutput } from "@/ai/prompt";
import type { ReconRow } from "@/reconcile/rows";

export type ClaimProblem =
  | "no_source"
  | `unknown_id:${string}`
  | `hallucinated_condition:${string}`
  | `miscited_condition:${string}`;

export interface CheckedClaim {
  kind: "SUMMARY" | "FLAG";
  topic: string;
  text: string;
  citedAliases: string[];
  /** Canonical ids of the cited aliases that resolved. */
  sourceIds: string[];
  problems: ClaimProblem[];
  valid: boolean;
}

export interface CheckedOutput {
  /** Output-level failure: unparseable JSON or a schema mismatch. Claims are empty then. */
  error: string | null;
  claims: CheckedClaim[];
}

const rowText = (r: ReconRow) =>
  [r.display, ...r.reactions.map((x) => x.manifestation)].join(" \n ");

export function checkClaim(
  kind: CheckedClaim["kind"],
  topic: string,
  text: string,
  citedAliases: string[],
  prepared: PreparedInput,
): CheckedClaim {
  const problems: ClaimProblem[] = [];
  const cited = [...new Set(citedAliases)];
  if (cited.length === 0) problems.push("no_source");
  const sourceIds: string[] = [];
  const citedRows: ReconRow[] = [];
  for (const alias of cited) {
    const id = prepared.aliases.get(alias);
    if (!id) problems.push(`unknown_id:${alias}`);
    else {
      sourceIds.push(id);
      citedRows.push(prepared.rowsByAlias.get(alias)!);
    }
  }
  const allRows = [...prepared.rowsByAlias.values()];
  for (const c of conditionMentions(text)) {
    if (citedRows.some((r) => supports(c, rowText(r)))) continue;
    problems.push(
      allRows.some((r) => supports(c, rowText(r)))
        ? `miscited_condition:${c.key}`
        : `hallucinated_condition:${c.key}`,
    );
  }
  return {
    kind,
    topic,
    text,
    citedAliases: cited,
    sourceIds,
    problems,
    valid: problems.length === 0,
  };
}

export function checkOutput(raw: string | null, prepared: PreparedInput): CheckedOutput {
  if (raw === null) return { error: "no_output", claims: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: "unparseable_json", claims: [] };
  }
  const parsed = aiOutputSchema.safeParse(json);
  if (!parsed.success) return { error: "schema_mismatch", claims: [] };
  return { error: null, claims: claimsOf(parsed.data, prepared) };
}

function claimsOf(out: AiOutput, prepared: PreparedInput): CheckedClaim[] {
  return [
    ...out.summary.map((s) => checkClaim("SUMMARY", s.topic, s.text, s.source_ids, prepared)),
    ...out.flags.map((f) => checkClaim("FLAG", f.type, f.text, f.source_ids, prepared)),
  ];
}
