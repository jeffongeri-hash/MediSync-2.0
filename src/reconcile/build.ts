// Incoming vs current chart: pair rows, then run the deterministic rules. Pure. The rules are authoritative; AI flags
// are shown apart as suggestions. Every flag cites the canonical ids it is about.
import { SYSTEM } from "@/mapping/systems";
import { localTerminology } from "@/mapping/terminology";
import { allergenProfile, drugProfile } from "@/reconcile/drugs";
import {
  currentAsOf,
  day,
  isActive,
  toReconRow,
  ts,
  type ReconRow,
  type SourceRow,
} from "@/reconcile/rows";

export const RULES_VERSION = "reconcile-rules@1";

export type Category = "PROBLEM" | "MEDICATION" | "ALLERGY" | "PMH";
export type MatchKind = "SAME" | "CHANGED" | "NEW" | "CURRENT_ONLY";
export type FlagCode =
  | "allergy_med_conflict"
  | "status_conflict"
  | "date_conflict"
  | "dose_change"
  | "therapeutic_duplication"
  | "possible_duplicate"
  | "adds_detail";
export type FlagSeverity = "high" | "warning" | "info";
export interface RuleFlag {
  code: FlagCode;
  severity: FlagSeverity;
  message: string;
  sourceIds: string[];
}
export interface ReconItem {
  ordinal: number;
  category: Category;
  match: MatchKind;
  current: ReconRow | null;
  incoming: ReconRow | null;
  flags: RuleFlag[];
}
export interface Reconciliation {
  cutoff: string;
  rulesVersion: string;
  current: ReconRow[];
  incoming: ReconRow[];
  items: ReconItem[];
}

export const CATEGORIES: Category[] = ["PROBLEM", "MEDICATION", "ALLERGY", "PMH"];
const SEVERITY_RANK: Record<FlagSeverity, number> = { high: 0, warning: 1, info: 2 };
const MATCH_RANK: Record<MatchKind, number> = { CHANGED: 0, NEW: 1, CURRENT_ONLY: 2, SAME: 3 };

type Pair = { current: ReconRow | null; incoming: ReconRow | null };

/** Pair incoming rows with current ones: dedupe link first, then same family + code + clinical day. */
export function pairRows(current: ReconRow[], incoming: ReconRow[]): Pair[] {
  const byId = new Map(current.map((r) => [r.id, r]));
  const used = new Set<string>();
  const pairs: Pair[] = [];
  const unlinked: ReconRow[] = [];
  for (const inc of incoming) {
    const cur = inc.duplicateOfId ? byId.get(inc.duplicateOfId) : undefined;
    if (cur && !used.has(cur.id) && cur.family === inc.family) {
      used.add(cur.id);
      pairs.push({ current: cur, incoming: inc });
    } else unlinked.push(inc);
  }
  for (const inc of unlinked) {
    const cur = current.find(
      (c) =>
        !used.has(c.id) &&
        c.family === inc.family &&
        c.code !== null &&
        c.code === inc.code &&
        c.codeSystem === inc.codeSystem &&
        day(c.start ?? c.recorded) === day(inc.start ?? inc.recorded),
    );
    if (cur) used.add(cur.id);
    pairs.push({ current: cur ?? null, incoming: inc });
  }
  for (const cur of current) if (!used.has(cur.id)) pairs.push({ current: cur, incoming: null });
  return pairs;
}

function categoryOf({ current, incoming }: Pair): Category {
  const any = (incoming ?? current)!;
  if (any.family === "medication") return "MEDICATION";
  if (any.family === "allergy") return "ALLERGY";
  return [current, incoming].some((r) => r && isActive(r)) ? "PROBLEM" : "PMH";
}

const label = (iso: string | null) => day(iso) ?? "none";

/** Field-level comparison of one matched pair. */
export function compareRows(cur: ReconRow, inc: ReconRow): RuleFlag[] {
  const ids = [cur.id, inc.id];
  const flags: RuleFlag[] = [];
  if (cur.status && inc.status && cur.status !== inc.status) {
    const asOf = cur.asOfCutoff ? " at the cutoff" : "";
    flags.push({
      code: "status_conflict",
      severity: "warning",
      message: `Status differs: current ${cur.status}${asOf}, incoming ${inc.status}.`,
      sourceIds: ids,
    });
  }
  const dateDiffs: string[] = [];
  const startName = cur.family === "medication" ? "Start" : "Onset";
  if (cur.start && inc.start && day(cur.start) !== day(inc.start))
    dateDiffs.push(`${startName} ${label(cur.start)} vs ${label(inc.start)}`);
  if (cur.end && inc.end && day(cur.end) !== day(inc.end))
    dateDiffs.push(`End ${label(cur.end)} vs ${label(inc.end)}`);
  if (dateDiffs.length > 0)
    flags.push({
      code: "date_conflict",
      severity: "warning",
      message: `Dates differ (current vs incoming): ${dateDiffs.join("; ")}.`,
      sourceIds: ids,
    });
  if (cur.dose && inc.dose && cur.dose !== inc.dose)
    flags.push({
      code: "dose_change",
      severity: "warning",
      message: `Dose differs: current ${cur.dose}, incoming ${inc.dose}.`,
      sourceIds: ids,
    });
  const extra: string[] = [];
  if (!cur.start && inc.start) extra.push(cur.family === "medication" ? "start date" : "onset");
  // An end date that comes with a status change is part of that change, not extra detail.
  if (!cur.end && inc.end && cur.status === inc.status) extra.push("end date");
  if (!cur.dose && inc.dose) extra.push("dose");
  if (!cur.criticality && inc.criticality) extra.push("criticality");
  if (cur.reactions.length === 0 && inc.reactions.length > 0) extra.push("reaction");
  else if (inc.reactions.some((r) => r.severity) && !cur.reactions.some((r) => r.severity))
    extra.push("reaction severity");
  if (extra.length > 0)
    flags.push({
      code: "adds_detail",
      severity: "info",
      message: `Incoming record adds: ${extra.join(", ")}.`,
      sourceIds: ids,
    });
  return flags;
}

const allergyActive = (r: ReconRow) => r.status === null || isActive(r);
/** The row that speaks for an item in cross-item rules: the first active one, incoming before current. */
function activeRep(item: ReconItem): ReconRow | null {
  for (const r of [item.incoming, item.current])
    if (r && (r.family === "allergy" ? allergyActive(r) : isActive(r))) return r;
  return null;
}
const intersect = (a: string[], b: string[]) => a.filter((x) => b.includes(x));

function medicationPair(a: ReconRow, b: ReconRow): RuleFlag | null {
  const ids = [a.id, b.id];
  if (a.code && a.code === b.code && a.codeSystem === b.codeSystem)
    return {
      code: "possible_duplicate",
      severity: "warning",
      message: `Same medication active twice: ${a.display}.`,
      sourceIds: ids,
    };
  const pa = drugProfile(a.codeSystem, a.code);
  const pb = drugProfile(b.codeSystem, b.code);
  if (!pa || !pb) return null;
  const sameIngredients =
    pa.ingredients.length === pb.ingredients.length &&
    pa.ingredients.every((i) => pb.ingredients.includes(i));
  if (sameIngredients)
    return {
      code: "dose_change",
      severity: "warning",
      message: `Same ingredients, different product or strength, both active: ${a.display} and ${b.display}.`,
      sourceIds: ids,
    };
  const shared = [
    ...intersect(pa.ingredients, pb.ingredients),
    ...intersect(pa.classes, pb.classes),
  ];
  return shared.length > 0
    ? {
        code: "therapeutic_duplication",
        severity: "warning",
        message: `Both active and both ${shared.join(", ")}: ${a.display} and ${b.display}.`,
        sourceIds: ids,
      }
    : null;
}

function allergyMedication(allergy: ReconRow, med: ReconRow): RuleFlag | null {
  const allergen = allergenProfile(allergy.codeSystem, allergy.code, allergy.display);
  const drug = drugProfile(med.codeSystem, med.code);
  if (!allergen || !drug) return null;
  const hits = [
    ...intersect(allergen.ingredients, drug.ingredients),
    ...intersect(allergen.classes, drug.classes),
  ];
  return hits.length > 0
    ? {
        code: "allergy_med_conflict",
        severity: "high",
        message: `Active medication ${med.display} contains ${hits.join(", ")}, listed as an allergy (${allergy.display}).`,
        sourceIds: [allergy.id, med.id],
      }
    : null;
}

const icdCodes = (r: ReconRow) =>
  r.codings.filter((c) => c.system === SYSTEM.ICD10CM).map((c) => c.code);
const snomedCodes = (r: ReconRow) =>
  r.codings.filter((c) => c.system === SYSTEM.SNOMED).map((c) => c.code);

/** An unmatched incoming condition that names a current one: same code both active, or via the ICD-10-CM crosswalk. */
function conditionPair(cur: ReconRow, inc: ReconRow): RuleFlag | null {
  const bothActive = isActive(cur) && isActive(inc);
  const sameDay = day(cur.start) !== null && day(cur.start) === day(inc.start);
  if (cur.code && cur.code === inc.code && cur.codeSystem === inc.codeSystem && bothActive)
    return {
      code: "possible_duplicate",
      severity: "warning",
      message: `Same problem active twice: ${cur.display}.`,
      sourceIds: [cur.id, inc.id],
    };
  const crosswalked = snomedCodes(cur).flatMap((s) => {
    const t = localTerminology.icd10cm(s);
    return t ? [t.code] : [];
  });
  const viaCrosswalk = intersect(crosswalked, icdCodes(inc)).length > 0;
  return viaCrosswalk && (bothActive || sameDay)
    ? {
        code: "possible_duplicate",
        severity: "warning",
        message: `Incoming ${inc.display} maps to the same ICD-10-CM code as current ${cur.display} (unverified crosswalk).`,
        sourceIds: [cur.id, inc.id],
      }
    : null;
}

/** Rules that look across items. Each flag is attached to every item it cites. */
function crossFlags(items: ReconItem[]): Map<number, RuleFlag[]> {
  const out = new Map<number, RuleFlag[]>();
  const add = (a: ReconItem, b: ReconItem, f: RuleFlag | null) => {
    if (!f) return;
    for (const it of [a, b]) out.set(it.ordinal, [...(out.get(it.ordinal) ?? []), f]);
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const ra = activeRep(a);
      const rb = activeRep(b);
      const fa = (a.incoming ?? a.current)!.family;
      const fb = (b.incoming ?? b.current)!.family;
      if (fa === "medication" && fb === "medication" && ra && rb)
        add(a, b, ra.side === "incoming" ? medicationPair(rb, ra) : medicationPair(ra, rb));
      else if (fa === "allergy" && fb === "medication" && ra && rb)
        add(a, b, allergyMedication(ra, rb));
      else if (fa === "medication" && fb === "allergy" && ra && rb)
        add(a, b, allergyMedication(rb, ra));
      else if (fa === "allergy" && fb === "allergy" && ra && rb && ra.code && ra.code === rb.code)
        add(a, b, {
          code: "possible_duplicate",
          severity: "warning",
          message: `Same allergy listed twice: ${ra.display}.`,
          sourceIds: [ra.id, rb.id],
        });
      else if (fa === "condition" && fb === "condition") {
        // Only an unmatched row can duplicate another item; a matched pair is already one fact.
        const pairs: [ReconRow | null, ReconRow | null][] = [
          [a.current ?? null, b.current ? null : b.incoming],
          [b.current ?? null, a.current ? null : a.incoming],
        ];
        for (const [cur, inc] of pairs) if (cur && inc) add(a, b, conditionPair(cur, inc));
      }
    }
  }
  return out;
}

const topSeverity = (flags: RuleFlag[]) =>
  Math.min(3, ...flags.map((f) => SEVERITY_RANK[f.severity]));

export function buildReconciliation(rows: SourceRow[], cutoff: Date): Reconciliation {
  const current = currentAsOf(
    rows
      .filter((r) => r.format === "FHIR_BUNDLE" && r.duplicateOfId === null)
      .map((r) => toReconRow(r, "current")),
    cutoff,
  );
  const incoming = rows.filter((r) => r.format === "CCDA").map((r) => toReconRow(r, "incoming"));
  const items: ReconItem[] = pairRows(current, incoming).map((p, ordinal) => {
    const flags = p.current && p.incoming ? compareRows(p.current, p.incoming) : [];
    const match: MatchKind =
      p.current && p.incoming
        ? flags.length > 0
          ? "CHANGED"
          : "SAME"
        : p.incoming
          ? "NEW"
          : "CURRENT_ONLY";
    return { ordinal, category: categoryOf(p), match, ...p, flags };
  });
  for (const [ordinal, flags] of crossFlags(items)) items[ordinal]!.flags.push(...flags);

  const when = (it: ReconItem) => ts((it.incoming ?? it.current)!.start) ?? 0;
  const sorted = [...items].sort(
    (a, b) =>
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
      topSeverity(a.flags) - topSeverity(b.flags) ||
      MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
      when(b) - when(a) ||
      (a.incoming ?? a.current)!.display.localeCompare((b.incoming ?? b.current)!.display) ||
      (a.incoming ?? a.current)!.id.localeCompare((b.incoming ?? b.current)!.id),
  );
  return {
    cutoff: cutoff.toISOString(),
    rulesVersion: RULES_VERSION,
    current,
    incoming,
    items: sorted.map((it, ordinal) => ({ ...it, ordinal })),
  };
}

/** Distinct flags (same code and cited ids counted once), for summaries and evals. */
export function distinctFlags(items: ReconItem[]): RuleFlag[] {
  const seen = new Map<string, RuleFlag>();
  for (const f of items.flatMap((it) => it.flags))
    seen.set(`${f.code}|${[...f.sourceIds].sort().join(",")}`, f);
  return [...seen.values()];
}
