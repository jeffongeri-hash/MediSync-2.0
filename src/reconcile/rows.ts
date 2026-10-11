// Reconcile row views: one canonical row (the mapped copy) reduced to what the side-by-side view, the rules and the
// model need. Pure; JSON-safe, so the same objects are stored on reconciliation_items and sent (aliased) to the model.
import type { SourceFormat } from "@/mapping/dedupe";
import { localTerminology } from "@/mapping/terminology";

export const RECONCILE_TYPES = [
  "Condition",
  "MedicationRequest",
  "MedicationStatement",
  "AllergyIntolerance",
] as const;
export type ReconcileType = (typeof RECONCILE_TYPES)[number];
export type Side = "current" | "incoming";
export type Family = "condition" | "medication" | "allergy";
export const FAMILY: Record<ReconcileType, Family> = {
  Condition: "condition",
  MedicationRequest: "medication",
  MedicationStatement: "medication",
  AllergyIntolerance: "allergy",
};

/** A canonical row as loaded for reconcile, from the database or an eval case. */
export interface SourceRow {
  id: string;
  resourceType: ReconcileType;
  format: SourceFormat;
  duplicateOfId: string | null;
  /** Primary code after mapping (medicationReference resolved). */
  codeSystem: string | null;
  code: string | null;
  /** The mapped copy. */
  resource: Record<string, unknown>;
}

export interface ReconRow {
  id: string;
  side: Side;
  resourceType: ReconcileType;
  family: Family;
  duplicateOfId: string | null;
  codeSystem: string | null;
  code: string | null;
  /** Every coding on the resource's code, for crosswalk duplicate checks. */
  codings: { system: string; code: string }[];
  display: string;
  /** clinicalStatus (Condition, AllergyIntolerance) or status (medications). */
  status: string | null;
  /** Clinical start: onset, authoredOn or effective start. */
  start: string | null;
  /** Abatement or effective end. */
  end: string | null;
  recorded: string | null;
  dose: string | null;
  asNeeded: boolean | null;
  dosageText: string | null;
  criticality: string | null;
  reactions: { manifestation: string; severity: string | null }[];
  /** A current-chart row whose status was re-evaluated at the cutoff because it changed after it. */
  asOfCutoff: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const firstCode = (cc: unknown) => str(obj(arr(obj(cc)?.coding)[0])?.code);

function codingsOf(cc: unknown): { system: string; code: string; display: string | null }[] {
  return arr(obj(cc)?.coding).flatMap((c) => {
    const system = str(obj(c)?.system);
    const code = str(obj(c)?.code);
    return system && code ? [{ system, code, display: str(obj(c)?.display) }] : [];
  });
}

function displayOf(cc: unknown, system: string | null, code: string | null): string {
  const codings = codingsOf(cc);
  const primary = codings.find((c) => c.system === system && c.code === code) ?? codings[0];
  const lookup = system && code ? localTerminology.lookup(system, code) : null;
  return (
    primary?.display ??
    str(obj(cc)?.text) ??
    (lookup?.status === "known" ? lookup.display : null) ??
    (code ? `code ${code}` : "(no code or text)")
  );
}

function doseOf(dosage: unknown) {
  const d = obj(arr(dosage)[0]);
  const q = obj(obj(arr(d?.doseAndRate)[0])?.doseQuantity);
  const value = q?.value;
  return {
    dose:
      typeof value === "number"
        ? [String(value), str(q?.unit) ?? str(q?.code)].filter(Boolean).join(" ")
        : null,
    asNeeded: typeof d?.asNeededBoolean === "boolean" ? d.asNeededBoolean : null,
    dosageText: str(d?.text),
  };
}

export function toReconRow(row: SourceRow, side: Side): ReconRow {
  const r = row.resource;
  const base = {
    id: row.id,
    side,
    resourceType: row.resourceType,
    family: FAMILY[row.resourceType],
    duplicateOfId: row.duplicateOfId,
    codeSystem: row.codeSystem,
    code: row.code,
    status: null,
    start: null,
    end: null,
    recorded: null,
    dose: null,
    asNeeded: null,
    dosageText: null,
    criticality: null,
    reactions: [],
    asOfCutoff: false,
  };
  switch (row.resourceType) {
    case "Condition":
      return {
        ...base,
        codings: codingsOf(r.code).map(({ system, code }) => ({ system, code })),
        display: displayOf(r.code, row.codeSystem, row.code),
        status: firstCode(r.clinicalStatus),
        start: str(r.onsetDateTime) ?? str(obj(r.onsetPeriod)?.start) ?? str(r.recordedDate),
        end: str(r.abatementDateTime) ?? str(obj(r.abatementPeriod)?.end),
        recorded: str(r.recordedDate),
      };
    case "MedicationRequest":
    case "MedicationStatement": {
      const isRequest = row.resourceType === "MedicationRequest";
      const cc = r.medicationCodeableConcept;
      return {
        ...base,
        ...doseOf(isRequest ? r.dosageInstruction : r.dosage),
        codings: codingsOf(cc).map(({ system, code }) => ({ system, code })),
        display: displayOf(cc, row.codeSystem, row.code),
        status: str(r.status),
        start: isRequest
          ? str(r.authoredOn)
          : (str(obj(r.effectivePeriod)?.start) ?? str(r.effectiveDateTime) ?? str(r.dateAsserted)),
        end: isRequest ? null : str(obj(r.effectivePeriod)?.end),
        recorded: isRequest ? str(r.authoredOn) : str(r.dateAsserted),
      };
    }
    case "AllergyIntolerance":
      return {
        ...base,
        codings: codingsOf(r.code).map(({ system, code }) => ({ system, code })),
        display: displayOf(r.code, row.codeSystem, row.code),
        status: firstCode(r.clinicalStatus),
        start: str(r.onsetDateTime) ?? str(obj(r.onsetPeriod)?.start),
        recorded: str(r.recordedDate),
        criticality: str(r.criticality),
        reactions: arr(r.reaction).map((x) => {
          const m = obj(arr(obj(x)?.manifestation)[0]);
          return {
            manifestation: str(m?.text) ?? codingsOf(m)[0]?.display ?? "(unspecified)",
            severity: str(obj(x)?.severity),
          };
        }),
      };
  }
}

export const ts = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};
export const day = (iso: string | null): string | null => {
  const t = ts(iso);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
};

/** Default cutoff: twelve months before the patient's latest encounter. */
export function defaultCutoff(lastEncounter: Date): Date {
  const d = new Date(lastEncounter);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}

const CONDITION_ACTIVE = new Set(["active", "recurrence", "relapse"]);
export const isActive = (row: ReconRow): boolean =>
  row.family === "condition" || row.family === "allergy"
    ? CONDITION_ACTIVE.has(row.status ?? "")
    : row.status === "active" || row.status === "on-hold" || row.status === "intended";

/**
 * The current chart as it stood at the cutoff: rows asserted after it are left out (they arrive as incoming), and a
 * condition that abated after the cutoff is shown active with no abatement. Rows with no date are kept.
 */
export function currentAsOf(rows: ReconRow[], cutoff: Date): ReconRow[] {
  const limit = cutoff.getTime();
  return rows.flatMap((row) => {
    const asserted = ts(row.start) ?? ts(row.recorded);
    if (asserted !== null && asserted > limit) return [];
    const end = ts(row.end);
    if (row.family === "condition" && end !== null && end > limit)
      return [{ ...row, status: "active", end: null, asOfCutoff: true }];
    return [row];
  });
}
