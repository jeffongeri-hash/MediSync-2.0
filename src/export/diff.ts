// Element-level dry-run diff: the source resource as received vs the exported copy, leaf by leaf.
// kept = same path, same value; changed = same path, new value; lost = source leaf with no counterpart;
// added = export leaf the source did not have (not scored). id, meta and resourceType are identity and metadata
// (reassigned by design, lineage is in Provenance), so they are not scored.
import type { DroppedReference } from "@/export/bundle";

type Json = Record<string, unknown>;

export type ChangeReason =
  | "reference_rewritten"
  | "system_normalized"
  | "code_normalized"
  | "unit_normalized"
  | "value_changed";
export type LossReason =
  "reference_outside_scope" | "reference_not_exported" | "resource_excluded" | "unexplained";
export type AddReason = "display_filled" | "ucum_coded" | "reference_note" | "other";
export type Finding<R> = { pattern: string; reason: R; example?: string };

export type ResourceDiff = {
  sourceLeaves: number;
  kept: number;
  changed: Finding<ChangeReason>[];
  lost: Finding<LossReason>[];
  added: Finding<AddReason>[];
};

const UNSCORED = new Set(["id", "meta", "resourceType"]);

/** Leaf path -> JSON value, e.g. "code.coding[0].system" -> "\"http://snomed.info/sct\"". */
export function flatten(
  node: unknown,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (!prefix && UNSCORED.has(k)) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else if (node !== undefined) {
    out.set(prefix, JSON.stringify(node));
  }
  return out;
}

/** "participant[0].individual.reference" -> "participant[].individual.reference" */
export const pattern = (path: string) => path.replace(/\[\d+\]/g, "[]");

const QUANTITY_ELEMENT = /^(\w*Quantity|quantity|low|high|numerator|denominator)$/;
const underQuantity = (path: string) =>
  path
    .split(".")
    .slice(0, -1)
    .some((s) => QUANTITY_ELEMENT.test(s.replace(/\[\d+\]$/, "")));
const last = (path: string) => path.slice(path.lastIndexOf(".") + 1);
const raw = (v: string) => String(JSON.parse(v));

function changeReason(path: string): ChangeReason {
  const leaf = last(path);
  if (leaf === "reference") return "reference_rewritten";
  if (leaf === "unit" || (underQuantity(path) && (leaf === "code" || leaf === "system")))
    return "unit_normalized";
  if (leaf === "system") return "system_normalized";
  if (leaf === "code" && path.includes("coding[")) return "code_normalized";
  return "value_changed";
}

function changeExample(
  path: string,
  reason: ChangeReason,
  before: string,
  after: string,
): string | undefined {
  if (reason === "reference_rewritten")
    return `${raw(before).split("/")[0]}/<id> -> urn:uuid:<entry>`;
  if (reason === "value_changed") return undefined; // values may be clinical free text; never echoed
  return `${raw(before)} -> ${raw(after)}`;
}

function addReason(path: string, dropped: DroppedReference[]): AddReason {
  const leaf = last(path);
  if (leaf === "display" && dropped.some((d) => path === `${d.path}.display`))
    return "reference_note";
  if (leaf === "display" && path.includes("coding[")) return "display_filled";
  if (underQuantity(path) && (leaf === "system" || leaf === "code")) return "ucum_coded";
  return "other";
}

/** Diffs one resource. `exported` is null when the resource was excluded (every source leaf is lost). */
export function diffResource(
  source: Json,
  exported: Json | null,
  dropped: DroppedReference[] = [],
): ResourceDiff {
  const before = flatten(source);
  const after = exported ? flatten(exported) : new Map<string, string>();
  const d: ResourceDiff = { sourceLeaves: before.size, kept: 0, changed: [], lost: [], added: [] };
  const droppedAt = new Map(dropped.map((x) => [`${x.path}.reference`, x]));
  for (const [path, value] of before) {
    const now = after.get(path);
    if (now === value) {
      d.kept++;
    } else if (now !== undefined) {
      const reason = changeReason(path);
      d.changed.push({
        pattern: pattern(path),
        reason,
        example: changeExample(path, reason, value, now),
      });
    } else {
      const ref = droppedAt.get(path);
      const reason: LossReason = !exported
        ? "resource_excluded"
        : ref
          ? ref.reason === "outside_scope"
            ? "reference_outside_scope"
            : "reference_not_exported"
          : "unexplained";
      d.lost.push({ pattern: pattern(path), reason, example: ref ? ref.targetType : undefined });
    }
  }
  for (const path of after.keys()) {
    if (!before.has(path))
      d.added.push({ pattern: pattern(path), reason: addReason(path, dropped) });
  }
  return d;
}

/**
 * Choice elements compare as one element across formats: performedDateTime and performedPeriod.start are both
 * performed[x] (the pattern stops at the first choice element).
 */
const CHOICE =
  /^(value|effective|onset|abatement|performed|occurrence|medication|deceased|multipleBirth|asNeeded|reported|dose|rate)(Quantity|CodeableConcept|String|Boolean|Integer|Range|Ratio|SampledData|Time|DateTime|Period|Date|Age|Reference|Attachment|Coding|Instant|Decimal|Duration|Timing)$/;
function elementPattern(path: string): string {
  const out: string[] = [];
  for (const seg of pattern(path).split(".")) {
    const m = CHOICE.exec(seg);
    out.push(m ? `${m[1]}[x]` : seg);
    if (m) break;
  }
  return out.join(".");
}

/** Element patterns a linked duplicate carries that the primary (as received) does not. */
export function duplicateOnlyPatterns(primary: Json, duplicate: Json): string[] {
  const have = new Set([...flatten(primary).keys()].map(elementPattern));
  return [...new Set([...flatten(duplicate).keys()].map(elementPattern))]
    .filter((p) => !have.has(p))
    .sort();
}

/** (kept + changed) / source leaves; 1 when there is nothing to transfer. */
export const completeness = (d: { sourceLeaves: number; kept: number; changed: number }) =>
  d.sourceLeaves ? (d.kept + d.changed) / d.sourceLeaves : 1;
