// The model's view of a reconciliation: every row under a short alias (C1.. current, I1.. incoming), the pairing,
// and the rule flags already raised. Aliases keep canonical ids out of the prompt and make citations checkable:
// a cited alias either resolves to a row that was sent, or the claim is invalid.
import { createHash } from "node:crypto";
import { SYSTEM } from "@/mapping/systems";
import type { Category, Reconciliation } from "@/reconcile/build";
import { day, type ReconRow } from "@/reconcile/rows";

export type AiList = "problem" | "past_history" | "medication" | "allergy";
const LIST: Record<Category, AiList> = {
  PROBLEM: "problem",
  PMH: "past_history",
  MEDICATION: "medication",
  ALLERGY: "allergy",
};
const SYSTEM_NAME: Record<string, string> = {
  [SYSTEM.SNOMED]: "SNOMED",
  [SYSTEM.RXNORM]: "RxNorm",
  [SYSTEM.ICD10CM]: "ICD-10-CM",
  [SYSTEM.LOINC]: "LOINC",
};

export interface AiRow {
  id: string;
  side: "current" | "incoming";
  list: AiList;
  type: string;
  code: string | null;
  display: string;
  status: string | null;
  start: string | null;
  end: string | null;
  dose?: string;
  dosage_text?: string;
  criticality?: string;
  reactions?: string[];
  /** The other side's copy of the same fact, when the rows were paired. */
  same_as?: string;
  /** Current row shown as it stood at the cutoff (its status changed after). */
  as_of_cutoff?: true;
}
export interface AiRuleFlag {
  id: string;
  code: string;
  message: string;
  rows: string[];
}
export interface AiInput {
  cutoff: string;
  rows: AiRow[];
  rule_flags: AiRuleFlag[];
}
export interface PreparedInput {
  input: AiInput;
  /** alias -> canonical id */
  aliases: Map<string, string>;
  /** alias -> the row as reconcile built it (display, reactions), for claim checks */
  rowsByAlias: Map<string, ReconRow>;
}

function aiRow(alias: string, r: ReconRow, list: AiList, sameAs: string | undefined): AiRow {
  const code = r.code ? `${SYSTEM_NAME[r.codeSystem ?? ""] ?? r.codeSystem} ${r.code}` : null;
  return {
    id: alias,
    side: r.side,
    list,
    type: r.resourceType,
    code,
    display: r.display,
    status: r.status,
    start: day(r.start ?? r.recorded),
    end: day(r.end),
    ...(r.dose ? { dose: r.dose } : {}),
    ...(r.dosageText ? { dosage_text: r.dosageText } : {}),
    ...(r.criticality ? { criticality: r.criticality } : {}),
    ...(r.reactions.length > 0
      ? {
          reactions: r.reactions.map((x) =>
            x.severity ? `${x.manifestation} (${x.severity})` : x.manifestation,
          ),
        }
      : {}),
    ...(sameAs ? { same_as: sameAs } : {}),
    ...(r.asOfCutoff ? { as_of_cutoff: true as const } : {}),
  };
}

export function prepareInput(recon: Reconciliation): PreparedInput {
  const aliasOf = new Map<string, string>(); // canonical id -> alias
  const aliases = new Map<string, string>();
  const rowsByAlias = new Map<string, ReconRow>();
  let c = 0;
  let i = 0;
  for (const it of recon.items) {
    for (const r of [it.current, it.incoming]) {
      if (!r || aliasOf.has(r.id)) continue;
      const alias = r.side === "current" ? `C${++c}` : `I${++i}`;
      aliasOf.set(r.id, alias);
      aliases.set(alias, r.id);
      rowsByAlias.set(alias, r);
    }
  }
  const rows = recon.items.flatMap((it) => {
    const list = LIST[it.category];
    const pair = it.current && it.incoming;
    return [it.current, it.incoming].flatMap((r) => {
      if (!r) return [];
      const other = r === it.current ? it.incoming : it.current;
      return [
        aiRow(aliasOf.get(r.id)!, r, list, pair && other ? aliasOf.get(other.id) : undefined),
      ];
    });
  });
  const seen = new Set<string>();
  const ruleFlags: AiRuleFlag[] = [];
  for (const f of recon.items.flatMap((it) => it.flags)) {
    const rowsCited = f.sourceIds.map((s) => aliasOf.get(s)!);
    const key = `${f.code}|${[...rowsCited].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ruleFlags.push({
      id: `F${ruleFlags.length + 1}`,
      code: f.code,
      message: f.message,
      rows: rowsCited,
    });
  }
  return {
    input: { cutoff: day(recon.cutoff)!, rows, rule_flags: ruleFlags },
    aliases,
    rowsByAlias,
  };
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
