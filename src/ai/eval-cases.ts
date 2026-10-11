// Eval cases (Phase 4 gate): the 10 seeded patients as received, plus the same 10 with 2-3 injected changes each.
// Built once from the database by `pnpm eval:build` and committed, so the eval set is frozen; ops are plain data.
import { CONDITION_CONCEPTS, supports } from "@/ai/conditions";
import { SYSTEM } from "@/mapping/systems";
import { buildReconciliation, type FlagCode, type ReconItem } from "@/reconcile/build";
import { ALLERGEN_TERMS, drugProfile } from "@/reconcile/drugs";
import { isActive, type ReconRow, type SourceRow } from "@/reconcile/rows";

export const PERTURBATION_TYPES = [
  "dose_change",
  "status_flip",
  "allergy_med",
  "recoded_duplicate",
  "decoy",
] as const;
export type PerturbationType = (typeof PERTURBATION_TYPES)[number];

export type EvalOp =
  | { op: "add"; row: SourceRow }
  /** Shallow merge into the row's resource. */
  | { op: "patch"; rowId: string; set: Record<string, unknown> };

export interface Perturbation {
  type: PerturbationType;
  description: string;
  ops: EvalOp[];
  /** The flag a reviewer should see (rules or AI), citing these rows; null for a decoy. */
  expect: { flag: FlagCode | null; sourceIds: string[]; trap?: string };
}
export interface EvalPatient {
  key: string;
  label: string;
  cutoff: string;
  rows: SourceRow[];
}
export interface EvalCase {
  id: string;
  patient: string;
  perturbations: Perturbation[];
}

export const LOCAL_CODE_SYSTEM = "urn:medisync:eval:local-code";
const CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
const ALLERGY_CLINICAL = "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";

const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * 86_400_000).toISOString().replace(".000Z", "Z");

/** Applies a case's ops to its patient's rows. Pure. */
export function materialize(patient: EvalPatient, kase: EvalCase): SourceRow[] {
  const rows = patient.rows.map((r) => ({ ...r, resource: { ...r.resource } }));
  for (const op of kase.perturbations.flatMap((p) => p.ops)) {
    if (op.op === "add") rows.push(op.row);
    else {
      const row = rows.find((r) => r.id === op.rowId);
      if (!row) throw new Error(`${kase.id}: patch target ${op.rowId} not found`);
      row.resource = { ...row.resource, ...op.set };
    }
  }
  return rows;
}

/** "Essential hypertension (disorder)" -> "Hypertension, essential": same fact, different wording. */
export function reword(display: string): string {
  const words = display
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .split(/\s+/);
  if (words.length < 2) return `${words[0]}, unspecified`;
  const last = words.at(-1)!;
  return `${last[0]!.toUpperCase()}${last.slice(1)}, ${words.slice(0, -1).join(" ").toLowerCase()}`;
}

interface Ctx {
  rows: SourceRow[];
  items: ReconItem[];
  cutoff: string;
  used: Set<string>;
  newId: () => string;
}
const free = (ctx: Ctx, ...rows: (ReconRow | null)[]) =>
  rows.every((r) => !r || !ctx.used.has(r.id));
const take = (ctx: Ctx, ...ids: string[]) => ids.forEach((id) => ctx.used.add(id));
const byActiveFirst = (a: ReconItem, b: ReconItem) =>
  Number(!!b.current && isActive(b.current)) - Number(!!a.current && isActive(a.current));

const MAKERS: Record<PerturbationType, (ctx: Ctx) => Perturbation | null> = {
  dose_change(ctx) {
    const it = ctx.items
      .filter(
        (i) =>
          i.category === "MEDICATION" &&
          i.current &&
          i.incoming &&
          free(ctx, i.current, i.incoming),
      )
      .sort(byActiveFirst)[0];
    if (!it) return null;
    const cur = it.current!;
    const inc = it.incoming!;
    const curRes = ctx.rows.find((r) => r.id === cur.id)!.resource;
    const first =
      (Array.isArray(curRes.dosageInstruction) ? curRes.dosageInstruction[0] : {}) ?? {};
    take(ctx, cur.id, inc.id);
    return {
      type: "dose_change",
      description: `Incoming dose of ${cur.display} is 2 tablets; the current chart says 1.`,
      ops: [
        {
          op: "patch",
          rowId: cur.id,
          set: {
            dosageInstruction: [
              { ...first, doseAndRate: [{ doseQuantity: { value: 1, unit: "tablet" } }] },
            ],
          },
        },
        {
          op: "patch",
          rowId: inc.id,
          set: { dosage: [{ doseAndRate: [{ doseQuantity: { value: 2, unit: "tablet" } }] }] },
        },
      ],
      expect: { flag: "dose_change", sourceIds: [cur.id, inc.id] },
    };
  },

  status_flip(ctx) {
    const it = ctx.items.find(
      (i) =>
        i.category === "PROBLEM" &&
        i.current &&
        i.incoming &&
        isActive(i.current) &&
        !i.current.asOfCutoff &&
        isActive(i.incoming) &&
        free(ctx, i.current, i.incoming),
    );
    if (!it) return null;
    take(ctx, it.current!.id, it.incoming!.id);
    return {
      type: "status_flip",
      description: `Incoming record marks ${it.incoming!.display} resolved; the current chart has it active.`,
      ops: [
        {
          op: "patch",
          rowId: it.incoming!.id,
          set: {
            clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "resolved" }] },
            abatementDateTime: plusDays(ctx.cutoff, 60),
          },
        },
      ],
      expect: { flag: "status_conflict", sourceIds: [it.current!.id, it.incoming!.id] },
    };
  },

  allergy_med(ctx) {
    for (const it of ctx.items.filter((i) => i.category === "MEDICATION").sort(byActiveFirst)) {
      const any = (it.current ?? it.incoming)!;
      const profile = drugProfile(any.codeSystem, any.code);
      const term =
        profile?.ingredients.find((i) => ALLERGEN_TERMS[i]) ??
        profile?.classes.find((c) => ALLERGEN_TERMS[c]);
      if (!term || !free(ctx, it.current, it.incoming)) continue;
      const ops: EvalOp[] = [];
      let med = [it.incoming, it.current].find((r) => r && isActive(r)) ?? null;
      if (!med) {
        med = it.incoming ?? it.current!;
        ops.push({ op: "patch", rowId: med.id, set: { status: "active" } });
      }
      const allergyId = ctx.newId();
      ops.push({
        op: "add",
        row: {
          id: allergyId,
          resourceType: "AllergyIntolerance",
          format: "CCDA",
          duplicateOfId: null,
          codeSystem: null,
          code: null,
          resource: {
            resourceType: "AllergyIntolerance",
            clinicalStatus: { coding: [{ system: ALLERGY_CLINICAL, code: "active" }] },
            category: ["medication"],
            code: { text: `Allergy to ${term}` },
            onsetDateTime: plusDays(ctx.cutoff, 30),
            reaction: [{ manifestation: [{ text: "Hives" }], severity: "moderate" }],
          },
        },
      });
      take(ctx, med.id);
      return {
        type: "allergy_med",
        description: `Incoming record lists an allergy to ${term}; ${med.display} is active.`,
        ops,
        expect: { flag: "allergy_med_conflict", sourceIds: [allergyId, med.id] },
      };
    }
    return null;
  },

  recoded_duplicate(ctx) {
    const cur = ctx.items
      .filter(
        (i) =>
          i.current?.family === "condition" &&
          free(ctx, i.current) &&
          i.current.display.includes(" "),
      )
      .sort(byActiveFirst)[0]?.current;
    if (!cur) return null;
    const id = ctx.newId();
    take(ctx, cur.id);
    const display = reword(cur.display);
    return {
      type: "recoded_duplicate",
      description: `Incoming record repeats ${cur.display} as "${display}" under a local code.`,
      ops: [
        {
          op: "add",
          row: {
            id,
            resourceType: "Condition",
            format: "CCDA",
            duplicateOfId: null,
            codeSystem: LOCAL_CODE_SYSTEM,
            code: `L${id.slice(-4)}`,
            resource: {
              resourceType: "Condition",
              clinicalStatus: {
                coding: [{ system: CONDITION_CLINICAL, code: cur.status ?? "active" }],
              },
              code: {
                coding: [{ system: LOCAL_CODE_SYSTEM, code: `L${id.slice(-4)}`, display }],
                text: display,
              },
              ...(cur.start ? { onsetDateTime: cur.start } : {}),
            },
          },
        },
      ],
      expect: { flag: "possible_duplicate", sourceIds: [cur.id, id] },
    };
  },

  decoy(ctx) {
    const options = [
      { display: "Prediabetes (finding)", code: "714628002", trap: "diabetes" },
      { display: "Acute bronchitis (disorder)", code: "10509002", trap: "copd" },
      { display: "Viral sinusitis (disorder)", code: "444814009", trap: "chronic sinusitis" },
    ];
    const texts = ctx.items
      .flatMap((i) => [i.current, i.incoming])
      .flatMap((r) => (r ? [r.display] : []));
    const pick = options.find((o) => {
      const concept = CONDITION_CONCEPTS.find((c) => c.key === o.trap)!;
      return !texts.includes(o.display) && !texts.some((t) => supports(concept, t));
    });
    if (!pick) return null;
    const id = ctx.newId();
    return {
      type: "decoy",
      description: `Incoming record adds ${pick.display}, a near miss for ${pick.trap}; no claim may name ${pick.trap}.`,
      ops: [
        {
          op: "add",
          row: {
            id,
            resourceType: "Condition",
            format: "CCDA",
            duplicateOfId: null,
            codeSystem: SYSTEM.SNOMED,
            code: pick.code,
            resource: {
              resourceType: "Condition",
              clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "active" }] },
              code: { coding: [{ system: SYSTEM.SNOMED, code: pick.code, display: pick.display }] },
              onsetDateTime: plusDays(ctx.cutoff, 45),
            },
          },
        },
      ],
      expect: { flag: null, sourceIds: [id], trap: pick.trap },
    };
  },
};

/** 2 or 3 perturbations for patient `index`, cycling through the types; inapplicable ones are skipped. */
export function perturbationsFor(
  index: number,
  patient: EvalPatient,
  caseNo: number,
): Perturbation[] {
  let n = 0;
  const ctx: Ctx = {
    rows: patient.rows,
    items: buildReconciliation(patient.rows, new Date(patient.cutoff)).items,
    cutoff: patient.cutoff,
    used: new Set(),
    newId: () =>
      `eeeeeeee-0000-4000-8000-${String(caseNo).padStart(4, "0")}${String(++n).padStart(8, "0")}`,
  };
  const want = index % 2 === 0 ? 3 : 2;
  const out: Perturbation[] = [];
  for (let k = 0; k < PERTURBATION_TYPES.length && out.length < want; k++) {
    const p = MAKERS[PERTURBATION_TYPES[(index + k) % PERTURBATION_TYPES.length]!](ctx);
    if (p) out.push(p);
  }
  return out;
}

/** Cases 1-10: each patient as received. Cases 11-20: the same patients with injected changes. */
export function buildCases(patients: EvalPatient[]): EvalCase[] {
  const id = (n: number) => `case-${String(n).padStart(2, "0")}`;
  return [
    ...patients.map((p, i) => ({ id: id(i + 1), patient: p.key, perturbations: [] })),
    ...patients.map((p, i) => ({
      id: id(patients.length + i + 1),
      patient: p.key,
      perturbations: perturbationsFor(i, p, patients.length + i + 1),
    })),
  ];
}
