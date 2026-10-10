// Canonical resource (as received) -> mapped canonical resource. Pure: same input, same output, so the DB pass
// can recompute `mapped` from `resource` whenever MAPPING_VERSION changes.
import { issue, type CanonicalResource, type CanonicalType, type IngestIssue } from "@/canonical";
import { normalizeSystem, SYSTEM } from "@/mapping/systems";
import { normalizeCode, ucumCode, UCUM_UNITS, type TerminologySource } from "@/mapping/terminology";

/** Bump when mapping output changes; the DB pass re-maps every row whose mapping_version differs. */
export const MAPPING_VERSION = "phase2.0";

/** Marks codings this app derived (never sent by the source), e.g. ICD-10-CM from the local crosswalk. */
export const DERIVED_CODING_EXT = "urn:medisync:extension:derived-coding";

export type MappingStatus = "MAPPED" | "UNMAPPED" | "NO_CODE" | "NOT_APPLICABLE";
type Coding = { system?: string; code?: string; display?: string; [k: string]: unknown };
type Concept = { coding?: Coding[]; text?: string; [k: string]: unknown };
type Quantity = {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
  [k: string]: unknown;
};
type Json = Record<string, unknown>;

export type MapContext = {
  sourceRecordId: string;
  sourceSystem: string;
  terminology: TerminologySource;
  /** The patient's Medication resources by "Medication/<id>", for resolving medicationReference. */
  medications: ReadonlyMap<string, CanonicalResource>;
};

export type MapResult = {
  mapped: CanonicalResource;
  status: MappingStatus;
  primary: { system: string; code: string } | null;
  /** The clinical date the source asserts (ISO 8601), for provenance and content-based dedupe. */
  sourceDate: string | null;
  issues: IngestIssue[];
};

/** Terminologies each type's primary code should use, in order of preference (CLAUDE.md conventions). */
export const TARGET_SYSTEMS: Record<Exclude<CanonicalType, "Patient">, string[]> = {
  Condition: [SYSTEM.SNOMED, SYSTEM.ICD10CM],
  AllergyIntolerance: [SYSTEM.SNOMED, SYSTEM.RXNORM],
  Medication: [SYSTEM.RXNORM],
  MedicationRequest: [SYSTEM.RXNORM],
  MedicationStatement: [SYSTEM.RXNORM],
  Observation: [SYSTEM.LOINC],
  Immunization: [SYSTEM.CVX],
  Procedure: [SYSTEM.SNOMED],
  Encounter: [SYSTEM.SNOMED],
  DocumentReference: [SYSTEM.LOINC],
};

const NAMES: Record<string, string> = {
  [SYSTEM.SNOMED]: "SNOMED CT",
  [SYSTEM.LOINC]: "LOINC",
  [SYSTEM.RXNORM]: "RxNorm",
  [SYSTEM.CVX]: "CVX",
  [SYSTEM.ICD10CM]: "ICD-10-CM",
  [SYSTEM.ICD9CM]: "ICD-9-CM",
  [SYSTEM.CPT]: "CPT",
  [SYSTEM.NDC]: "NDC",
};
export const systemName = (system: string) => NAMES[system] ?? system;

/** Element path of each type's primary concept (Encounter uses its first type). */
const PRIMARY_PATH: Record<Exclude<CanonicalType, "Patient">, string> = {
  Condition: "code",
  AllergyIntolerance: "code",
  Medication: "code",
  MedicationRequest: "medicationCodeableConcept",
  MedicationStatement: "medicationCodeableConcept",
  Observation: "code",
  Immunization: "vaccineCode",
  Procedure: "code",
  Encounter: "type[0]",
  DocumentReference: "type",
};

function primaryConcept(r: Json, type: Exclude<CanonicalType, "Patient">): Concept | undefined {
  if (type === "Encounter") return (r.type as Concept[] | undefined)?.[0];
  return r[PRIMARY_PATH[type]] as Concept | undefined;
}

/** Normalizes system URI and code on every coding in the resource (deep), in place. */
function normalizeCodings(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(normalizeCodings);
  if (typeof node !== "object" || node === null) return;
  const o = node as Json;
  if (Array.isArray(o.coding)) {
    for (const c of o.coding as Coding[]) {
      if (typeof c.system === "string") c.system = normalizeSystem(c.system);
      if (typeof c.code === "string") c.code = normalizeCode(c.system ?? "", c.code);
    }
  }
  Object.values(o).forEach(normalizeCodings);
}

const firstString = (...vals: unknown[]) => vals.find((v): v is string => typeof v === "string");

/** Partial FHIR dates ("2020", "2020-03") and date-only values become a full UTC instant. */
export function toInstant(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.length === 4 ? `${v}-01-01` : v.length === 7 ? `${v}-01` : v;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function clinicalDate(r: Json): string | null {
  const p = (k: string) => (r[k] as { start?: string } | undefined)?.start;
  switch (r.resourceType) {
    case "Condition":
      return toInstant(firstString(r.recordedDate, r.onsetDateTime, p("onsetPeriod")));
    case "AllergyIntolerance":
      return toInstant(firstString(r.recordedDate, r.onsetDateTime));
    case "MedicationRequest":
      return toInstant(firstString(r.authoredOn));
    case "MedicationStatement":
      return toInstant(firstString(r.dateAsserted, r.effectiveDateTime, p("effectivePeriod")));
    case "Observation":
      return toInstant(firstString(r.effectiveDateTime, p("effectivePeriod"), r.issued));
    case "Immunization":
      return toInstant(firstString(r.occurrenceDateTime, r.recorded));
    case "Procedure":
      return toInstant(firstString(r.performedDateTime, p("performedPeriod")));
    case "Encounter":
      return toInstant(p("period"));
    case "DocumentReference":
      return toInstant(firstString(r.date));
    default:
      return null;
  }
}

function mapQuantity(
  q: Quantity,
  path: string,
  at: Omit<IngestIssue, "severity" | "code" | "message">,
  out: IngestIssue[],
): void {
  const sys = q.system ? normalizeSystem(q.system) : undefined;
  if (sys && sys !== SYSTEM.UCUM) {
    out.push(
      issue("WARNING", "unmapped_unit", "Quantity uses a non-UCUM unit system", {
        ...at,
        path,
        details: { system: sys },
      }),
    );
    return;
  }
  const written = q.code ?? q.unit;
  if (written === undefined) return; // a unitless value (e.g. a count) is legitimate
  const code = ucumCode(written);
  if (!code) {
    out.push(
      issue(
        "WARNING",
        "unmapped_unit",
        "Quantity unit is not UCUM and has no known UCUM equivalent",
        { ...at, path, details: { unit: written } },
      ),
    );
    return;
  }
  q.system = SYSTEM.UCUM;
  q.code = code;
  q.unit ??= UCUM_UNITS[code] ?? code;
}

export function mapResource(resource: CanonicalResource, ctx: MapContext): MapResult {
  const r = structuredClone(resource) as Json;
  const type = resource.resourceType;
  const at = { resourceType: type, fhirId: resource.id };
  const issues: IngestIssue[] = [];
  normalizeCodings(r);
  r.meta = {
    ...(r.meta as Json | undefined),
    source: `urn:medisync:source:${encodeURIComponent(ctx.sourceSystem)}#${ctx.sourceRecordId}`,
  };
  const result = (status: MappingStatus, primary: MapResult["primary"] = null): MapResult => ({
    mapped: r as CanonicalResource,
    status,
    primary,
    sourceDate: clinicalDate(r),
    issues,
  });
  if (type === "Patient") return result("NOT_APPLICABLE");

  // Units: Observation values and components.
  if (type === "Observation") {
    if (r.valueQuantity)
      mapQuantity(r.valueQuantity as Quantity, "Observation.valueQuantity", at, issues);
    ((r.component as Json[] | undefined) ?? []).forEach((c, i) => {
      if (c.valueQuantity)
        mapQuantity(
          c.valueQuantity as Quantity,
          `Observation.component[${i}].valueQuantity`,
          at,
          issues,
        );
    });
  }

  // Primary concept; a medicationReference borrows the referenced Medication's code.
  let concept = primaryConcept(r, type);
  let path = `${type}.${PRIMARY_PATH[type]}`;
  const medRef = (r.medicationReference as { reference?: string } | undefined)?.reference;
  if (!concept && medRef) {
    const med = ctx.medications.get(medRef);
    if (!med) {
      issues.push(
        issue(
          "WARNING",
          "unresolved_reference",
          `${type}.medicationReference does not resolve to a Medication for this patient`,
          { ...at, path: `${type}.medicationReference` },
        ),
      );
      return result("NO_CODE");
    }
    concept = structuredClone((med as Json).code as Concept | undefined);
    normalizeCodings(concept);
    path = `${type}.medicationReference -> Medication.code`;
  }
  const codings = (concept?.coding ?? []).filter((c) => c.system && c.code);
  if (!codings.length) return result("NO_CODE"); // Phase 1 already raised missing_code

  // Fill missing displays for every coding we know, then pick the primary coding by target-system preference.
  for (const c of codings) {
    const hit = ctx.terminology.lookup(c.system!, c.code!);
    if (hit.status === "known" && !c.display) c.display = hit.display;
  }
  const targets = TARGET_SYSTEMS[type];
  const chosen = targets.map((s) => codings.find((c) => c.system === s)).find(Boolean);
  if (!chosen) {
    const found = [...new Set(codings.map((c) => systemName(c.system!)))].join(", ");
    issues.push(
      issue(
        "WARNING",
        "unmapped_code",
        `${type} has no ${targets.map(systemName).join(" or ")} code (found ${found})`,
        {
          ...at,
          path,
          details: { system: codings[0]!.system!, code: codings[0]!.code! },
        },
      ),
    );
    return result("UNMAPPED", { system: codings[0]!.system!, code: codings[0]!.code! });
  }
  const primary = { system: chosen.system!, code: chosen.code! };
  const hit = ctx.terminology.lookup(primary.system, primary.code);
  if (hit.status !== "known") {
    const why =
      hit.status === "malformed"
        ? hit.reason
        : `${systemName(primary.system)} code is not in the local terminology table`;
    issues.push(issue("WARNING", "unmapped_code", why, { ...at, path, details: { ...primary } }));
    return result("UNMAPPED", primary);
  }

  // Condition: add the ICD-10-CM diagnosis code from the crosswalk when the source sent SNOMED only.
  if (
    type === "Condition" &&
    primary.system === SYSTEM.SNOMED &&
    !codings.some((c) => c.system === SYSTEM.ICD10CM)
  ) {
    const target = ctx.terminology.icd10cm(primary.code);
    if (target) {
      concept!.coding!.push({
        system: SYSTEM.ICD10CM,
        code: target.code,
        display: target.display,
        extension: [
          {
            url: DERIVED_CODING_EXT,
            valueString: `local SNOMED CT to ICD-10-CM crosswalk (${MAPPING_VERSION}, unverified)`,
          },
        ],
      });
    } else if (target === null) {
      issues.push(
        issue(
          "INFO",
          "no_target_code",
          "SNOMED CT concept is a social or administrative finding with no ICD-10-CM code",
          { ...at, path, details: { ...primary } },
        ),
      );
    } else {
      issues.push(
        issue("WARNING", "unmapped_code", "SNOMED CT concept is not in the ICD-10-CM crosswalk", {
          ...at,
          path,
          details: { ...primary, target: "ICD-10-CM" },
        }),
      );
    }
  }
  return result("MAPPED", primary);
}
