// Canonical (mapped) resource -> US Core export copy. Pure. Profile URLs and the profile choice per resource are
// from memory of US Core 6.1.0 (hl7.org is blocked by the network policy); see docs/NOTES.md.
import type { CanonicalResource, CanonicalType } from "@/canonical";
import { DERIVED_CODING_EXT } from "@/mapping/map-resource";
import { SYSTEM } from "@/mapping/systems";

export const US_CORE_VERSION = "6.1.0";
export const TARGET_PROFILE = `us-core@${US_CORE_VERSION}`;
const BASE = "http://hl7.org/fhir/us/core/StructureDefinition/";
export const profileUrl = (id: string) => `${BASE}${id}|${US_CORE_VERSION}`;

type Json = Record<string, unknown>;
type Concept = { coding?: { system?: string; code?: string; extension?: { url?: string }[] }[] };

/** Vital-sign LOINC codes with their own US Core profile; other vital signs use us-core-vital-signs. */
const VITAL_PROFILES: Record<string, string> = {
  "85354-9": "us-core-blood-pressure",
  "8867-4": "us-core-heart-rate",
  "9279-1": "us-core-respiratory-rate",
  "8310-5": "us-core-body-temperature",
  "8302-2": "us-core-body-height",
  "29463-7": "us-core-body-weight",
  "39156-5": "us-core-bmi",
  "59576-9": "pediatric-bmi-for-age",
  "77606-2": "pediatric-weight-for-height",
  "8289-1": "head-occipital-frontal-circumference-percentile",
  "9843-4": "us-core-head-circumference",
  "59408-5": "us-core-pulse-oximetry",
  "2708-6": "us-core-pulse-oximetry",
};

const ONE_PROFILE: Partial<Record<CanonicalType, string>> = {
  Patient: "us-core-patient",
  AllergyIntolerance: "us-core-allergyintolerance",
  Encounter: "us-core-encounter",
  Immunization: "us-core-immunization",
  Medication: "us-core-medication",
  MedicationRequest: "us-core-medicationrequest",
  Procedure: "us-core-procedure",
  DocumentReference: "us-core-documentreference",
};

const categoryCodes = (r: Json) =>
  ((r.category as Concept[] | undefined) ?? []).flatMap((c) => (c.coding ?? []).map((x) => x.code));

/** The US Core profile id a resource is checked against, or null when the IG has none (MedicationStatement). */
export function profileFor(resource: CanonicalResource): string | null {
  const r = resource as Json;
  const type = resource.resourceType;
  const one = ONE_PROFILE[type];
  if (one) return one;
  const cats = categoryCodes(r);
  if (type === "Condition") {
    if (cats.includes("encounter-diagnosis")) return "us-core-condition-encounter-diagnosis";
    if (cats.includes("problem-list-item") || cats.includes("health-concern"))
      return "us-core-condition-problems-health-concerns";
    return r.encounter
      ? "us-core-condition-encounter-diagnosis"
      : "us-core-condition-problems-health-concerns";
  }
  if (type === "Observation") {
    const loinc = ((r.code as Concept | undefined)?.coding ?? []).find(
      (c) => c.system === SYSTEM.LOINC,
    )?.code;
    if (cats.includes("vital-signs"))
      return (loinc && VITAL_PROFILES[loinc]) || "us-core-vital-signs";
    if (cats.includes("laboratory")) return "us-core-observation-lab";
    if (cats.includes("social-history") && loinc === "72166-2") return "us-core-smokingstatus";
    if (cats.includes("survey")) return "us-core-observation-screening-assessment";
    if (cats.includes("imaging") || cats.includes("procedure"))
      return "us-core-observation-clinical-result";
    return "us-core-simple-observation";
  }
  return null;
}

/** Removes codings this app derived (unverified crosswalk) everywhere in the resource; returns how many. */
function withholdDerivedCodings(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + withholdDerivedCodings(x), 0);
  if (typeof node !== "object" || node === null) return 0;
  const o = node as Json;
  let n = 0;
  if (Array.isArray(o.coding)) {
    const list = o.coding as { extension?: { url?: string }[] }[];
    const kept = list.filter((c) => !(c.extension ?? []).some((e) => e.url === DERIVED_CODING_EXT));
    n += list.length - kept.length;
    if (kept.length) o.coding = kept;
    else delete o.coding; // FHIR arrays are never empty
  }
  for (const v of Object.values(o)) n += withholdDerivedCodings(v);
  return n;
}

export type UsCoreResult = {
  resource: CanonicalResource;
  /** Profile id (no version), or null when US Core has no profile for the type. */
  profile: string | null;
  /** Derived codings left out of the export (the crosswalk is unverified, so they are never sent). */
  withheldDerivedCodings: number;
};

/**
 * The export copy of a mapped resource: meta is replaced by the versioned US Core profile (lineage moves to the
 * Provenance resources) and derived codings are withheld. References are rewritten later, at bundle assembly.
 */
export function toUsCore(mapped: CanonicalResource): UsCoreResult {
  const rest = structuredClone(mapped) as Json;
  const resourceType = rest.resourceType;
  delete rest.resourceType;
  delete rest.meta;
  const withheld = withholdDerivedCodings(rest);
  const profile = profileFor(mapped);
  const resource = {
    resourceType,
    ...(profile ? { meta: { profile: [profileUrl(profile)] } } : {}),
    ...rest,
  };
  return { resource: resource as CanonicalResource, profile, withheldDerivedCodings: withheld };
}
