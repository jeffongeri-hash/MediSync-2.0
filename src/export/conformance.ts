// Local US Core 6.1.0 conformance checks: the mandatory elements and must-support elements we know, written from
// memory because the IG cannot be fetched (docs/NOTES.md). A missing mandatory element excludes the resource;
// absent must-support elements are a warning. When unsure whether an element is 1..1, it is listed as must-support,
// so an error in this table can only cause a warning, never silently drop data.
import type { CanonicalResource } from "@/canonical";

type Json = Record<string, unknown>;
export type Rule = { label: string; ok: (r: Json) => boolean };
export type ConformanceResult = {
  /** Labels of mandatory rules that failed; non-empty means the resource is not exported. */
  missing: string[];
  /** Labels of must-support elements that are absent. */
  mustSupportMissing: string[];
};

const isPresent = (v: unknown) =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** Keys of `node` matching one segment: "name", "value[x]" (choice) or "url|data" (alternatives). */
function values(node: unknown, segment: string): unknown[] {
  if (typeof node !== "object" || node === null) return [];
  const o = node as Json;
  return segment.split("|").flatMap((s) => {
    if (!s.endsWith("[x]")) return isPresent(o[s]) ? [o[s]] : [];
    const prefix = s.slice(0, -3);
    return Object.keys(o)
      .filter(
        (k) => k.startsWith(prefix) && /^[A-Z]/.test(k.slice(prefix.length)) && isPresent(o[k]),
      )
      .map((k) => o[k]);
  });
}

/** Some value exists at the dotted path (any array element). */
function anyHas(node: unknown, path: string[]): boolean {
  const [head, ...rest] = path;
  const found = values(node, head!);
  if (!rest.length) return found.length > 0;
  return found.some((v) => asList(v).some((el) => anyHas(el, rest)));
}

/** FHIR cardinality: the last segment is required inside every parent that exists (vacuous if no parent). */
function everyHas(node: unknown, path: string[]): boolean {
  const [head, ...rest] = path;
  const found = values(node, head!);
  if (!rest.length) return found.length > 0;
  return found.every((v) => asList(v).every((el) => everyHas(el, rest)));
}

const req = (path: string): Rule => ({ label: path, ok: (r) => everyHas(r, path.split(".")) });
const ms = (path: string): Rule => ({ label: path, ok: (r) => anyHas(r, path.split(".")) });
const ext = (name: string, url: string): Rule => ({
  label: `extension:${name}`,
  ok: (r) => asList(r.extension ?? []).some((e) => (e as Json)?.url === url),
});

const OBS = [req("status"), req("category"), req("code"), req("subject")];
const VITAL = [...OBS, req("effective[x]"), req("value[x]|component|dataAbsentReason")];
const OBS_MS = [ms("effective[x]"), ms("value[x]|component|dataAbsentReason")];
const CONDITION = [req("category"), req("code"), req("subject")];
const CONDITION_MS = [
  ms("clinicalStatus"),
  ms("verificationStatus"),
  ms("onset[x]"),
  ms("recordedDate"),
];

/** The rules each profile is checked against: [mandatory, must-support]. */
export const RULES: Record<string, [Rule[], Rule[]]> = {
  "us-core-patient": [
    [
      req("identifier"),
      req("identifier.system"),
      req("identifier.value"),
      req("name"),
      req("name.family|given"),
      req("gender"),
    ],
    [
      ms("birthDate"),
      ms("address"),
      ms("telecom"),
      ms("communication"),
      ext("race", "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race"),
      ext("ethnicity", "http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity"),
    ],
  ],
  "us-core-allergyintolerance": [
    [
      req("code"),
      req("patient"),
      {
        // ait-1 (base R4): clinicalStatus SHALL be present unless verificationStatus is entered-in-error.
        label: "clinicalStatus (unless entered-in-error)",
        ok: (r) =>
          isPresent(r.clinicalStatus) ||
          JSON.stringify(r.verificationStatus ?? "").includes('"entered-in-error"'),
      },
    ],
    [ms("verificationStatus")],
  ],
  "us-core-condition-encounter-diagnosis": [CONDITION, [...CONDITION_MS, ms("encounter")]],
  "us-core-condition-problems-health-concerns": [CONDITION, CONDITION_MS],
  "us-core-encounter": [
    [
      req("status"),
      req("class"),
      req("type"),
      req("subject"),
      req("identifier.system"),
      req("identifier.value"),
    ],
    [
      ms("identifier"),
      ms("period"),
      ms("participant"),
      ms("reasonCode|reasonReference"),
      ms("location"),
      ms("serviceProvider"),
    ],
  ],
  "us-core-immunization": [
    [req("status"), req("vaccineCode"), req("patient"), req("occurrence[x]"), req("primarySource")],
    [],
  ],
  "us-core-medication": [[req("code")], []],
  "us-core-medicationrequest": [
    [req("status"), req("intent"), req("medication[x]"), req("subject")],
    [ms("authoredOn"), ms("requester"), ms("dosageInstruction"), ms("encounter")],
  ],
  "us-core-procedure": [[req("status"), req("code"), req("subject")], [ms("performed[x]")]],
  "us-core-documentreference": [
    [
      req("status"),
      req("type"),
      req("category"),
      req("subject"),
      req("content"),
      req("content.attachment"),
      req("content.attachment.url|data"),
    ],
    [
      ms("date"),
      ms("author"),
      ms("context.encounter"),
      ms("context.period"),
      ms("content.attachment.contentType"),
    ],
  ],
  "us-core-observation-lab": [OBS, OBS_MS],
  "us-core-smokingstatus": [[...OBS, req("value[x]")], [ms("effective[x]")]],
  "us-core-observation-screening-assessment": [OBS, OBS_MS],
  "us-core-observation-clinical-result": [OBS, OBS_MS],
  "us-core-simple-observation": [OBS, OBS_MS],
  "us-core-vital-signs": [VITAL, []],
  "us-core-blood-pressure": [[...VITAL, req("component")], []],
  "us-core-provenance": [
    [req("target"), req("recorded"), req("agent"), req("agent.who")],
    [ms("agent.type"), ms("entity")],
  ],
};
for (const id of [
  "us-core-heart-rate",
  "us-core-respiratory-rate",
  "us-core-body-temperature",
  "us-core-body-height",
  "us-core-body-weight",
  "us-core-bmi",
  "pediatric-bmi-for-age",
  "pediatric-weight-for-height",
  "head-occipital-frontal-circumference-percentile",
  "us-core-head-circumference",
  "us-core-pulse-oximetry",
]) {
  RULES[id] = RULES["us-core-vital-signs"]!;
}

/** Checks a resource against a profile id's rules; a profile with no rules here passes (and is reported). */
export function checkConformance(
  resource: CanonicalResource | Json,
  profile: string | null,
): ConformanceResult {
  const rules = profile ? RULES[profile] : undefined;
  if (!rules) return { missing: [], mustSupportMissing: [] };
  const r = resource as Json;
  const [mandatory, mustSupport] = rules;
  return {
    missing: mandatory.filter((x) => !x.ok(r)).map((x) => x.label),
    mustSupportMissing: mustSupport.filter((x) => !x.ok(r)).map((x) => x.label),
  };
}
