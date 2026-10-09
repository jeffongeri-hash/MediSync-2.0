/** Resource types Phase 1 must ingest, in display order. Medication* types are combined. */
export const PHASE1_COLUMNS = [
  { key: "Condition", label: "Conditions", types: ["Condition"] },
  { key: "Medication", label: "Meds", types: ["MedicationRequest", "MedicationStatement"] },
  { key: "AllergyIntolerance", label: "Allergies", types: ["AllergyIntolerance"] },
  { key: "Observation", label: "Obs", types: ["Observation"] },
  { key: "Immunization", label: "Immun.", types: ["Immunization"] },
  { key: "Procedure", label: "Proc.", types: ["Procedure"] },
  { key: "Encounter", label: "Enc.", types: ["Encounter"] },
  { key: "DocumentReference", label: "Docs", types: ["DocumentReference"] },
] as const;

export function phase1Counts(resourceCounts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    PHASE1_COLUMNS.map((c) => [c.key, c.types.reduce((n, t) => n + (resourceCounts[t] ?? 0), 0)]),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ageOn(birthDate: Date, on: Date): number {
  const age = on.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < birthDate.getUTCMonth() ||
    (on.getUTCMonth() === birthDate.getUTCMonth() && on.getUTCDate() < birthDate.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}
