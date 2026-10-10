// Code system identity: one place that turns OIDs, aliases and URI variants into the FHIR R4 system URI.
// URIs and OIDs are from memory and unverified against hl7.org (blocked); see docs/NOTES.md.

export const SYSTEM = {
  SNOMED: "http://snomed.info/sct",
  LOINC: "http://loinc.org",
  RXNORM: "http://www.nlm.nih.gov/research/umls/rxnorm",
  CVX: "http://hl7.org/fhir/sid/cvx",
  ICD10CM: "http://hl7.org/fhir/sid/icd-10-cm",
  ICD9CM: "http://hl7.org/fhir/sid/icd-9-cm",
  CPT: "http://www.ama-assn.org/go/cpt",
  NDC: "http://hl7.org/fhir/sid/ndc",
  UNII: "http://fdasis.nlm.nih.gov",
  UCUM: "http://unitsofmeasure.org",
} as const;

/** HL7 OIDs -> FHIR R4 system URIs. Used by the C-CDA parser and for `urn:oid:` codings from any source. */
export const OID_SYSTEMS: Record<string, string> = {
  "2.16.840.1.113883.6.96": SYSTEM.SNOMED,
  "2.16.840.1.113883.6.1": SYSTEM.LOINC,
  "2.16.840.1.113883.6.88": SYSTEM.RXNORM,
  "2.16.840.1.113883.12.292": SYSTEM.CVX,
  "2.16.840.1.113883.6.90": SYSTEM.ICD10CM,
  "2.16.840.1.113883.6.103": SYSTEM.ICD9CM,
  "2.16.840.1.113883.6.12": SYSTEM.CPT,
  "2.16.840.1.113883.6.69": SYSTEM.NDC,
  "2.16.840.1.113883.4.9": SYSTEM.UNII,
  "2.16.840.1.113883.6.8": SYSTEM.UCUM,
  "2.16.840.1.113883.5.4": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  "2.16.840.1.113883.5.1": "http://terminology.hl7.org/CodeSystem/v3-AdministrativeGender",
  "2.16.840.1.113883.5.83": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
  "2.16.840.1.113883.6.238": "urn:oid:2.16.840.1.113883.6.238",
};

/** Names and URI variants seen in the wild, keyed lower-case without a trailing slash. */
const ALIASES: Record<string, string> = {
  snomed: SYSTEM.SNOMED,
  "snomed-ct": SYSTEM.SNOMED,
  snomedct: SYSTEM.SNOMED,
  sct: SYSTEM.SNOMED,
  "https://snomed.info/sct": SYSTEM.SNOMED,
  loinc: SYSTEM.LOINC,
  "https://loinc.org": SYSTEM.LOINC,
  rxnorm: SYSTEM.RXNORM,
  "https://www.nlm.nih.gov/research/umls/rxnorm": SYSTEM.RXNORM,
  cvx: SYSTEM.CVX,
  "icd-10-cm": SYSTEM.ICD10CM,
  icd10cm: SYSTEM.ICD10CM,
  ucum: SYSTEM.UCUM,
};

const OID = /^[0-2](\.(0|[1-9][0-9]*))+$/;
// SNOMED edition URIs (".../sct/<module id>[/version/<date>]") belong in Coding.version, not Coding.system.
const SNOMED_EDITION = /^https?:\/\/snomed\.info\/sct\/\d+(\/version\/\d{8})?$/;

/** Returns the FHIR R4 URI for a system written as a URI, `urn:oid:`, bare OID, or common alias; otherwise the input. */
export function normalizeSystem(system: string): string {
  const s = system.trim();
  const oid = s.startsWith("urn:oid:") ? s.slice("urn:oid:".length) : OID.test(s) ? s : null;
  if (oid) return OID_SYSTEMS[oid] ?? `urn:oid:${oid}`;
  if (SNOMED_EDITION.test(s)) return SYSTEM.SNOMED;
  const key = s.toLowerCase().replace(/\/+$/, "");
  return ALIASES[key] ?? (isKnownSystem(key) ? key : s);
}

/** True when the system is one of the terminologies this app maps (vs an unknown or local code system). */
export function isKnownSystem(system: string): boolean {
  return (Object.values(SYSTEM) as string[]).includes(system);
}
