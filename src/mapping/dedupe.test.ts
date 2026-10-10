import { describe, expect, it } from "vitest";
import { dedupePatient, type DedupeRow } from "@/mapping/dedupe";

const SCT = "http://snomed.info/sct";
const row = (id: string, over: Partial<DedupeRow>): DedupeRow => ({
  id,
  resourceType: "Condition",
  fhirId: "c1",
  sourceRecordId: `src-${id}`,
  sourceSystem: "synthea",
  format: "FHIR_BUNDLE",
  codeSystem: SCT,
  code: "59621000",
  sourceDate: "2024-03-05T10:00:00.000Z",
  ...over,
});
const linkOf = (out: ReturnType<typeof dedupePatient>, id: string) => out.links.find((l) => l.id === id)!;

describe("dedupePatient", () => {
  it("links the same id across formats to the bundle row, MedicationRequest and MedicationStatement together", () => {
    const out = dedupePatient([
      row("ccda", { format: "CCDA" }),
      row("nd", { format: "FHIR_NDJSON" }),
      row("b", {}),
      row("mr", { resourceType: "MedicationRequest", fhirId: "m1", code: "314076" }),
      row("ms", { resourceType: "MedicationStatement", fhirId: "m1", code: "314076", format: "CCDA" }),
    ]);
    expect(linkOf(out, "b")).toEqual({ id: "b", dedupeKey: "id:Condition/synthea/c1", duplicateOfId: null, matchedBy: "id" });
    expect(linkOf(out, "nd").duplicateOfId).toBe("b");
    expect(linkOf(out, "ccda").duplicateOfId).toBe("b");
    expect(linkOf(out, "ms")).toMatchObject({ duplicateOfId: "mr", dedupeKey: "id:MedicationUse/synthea/m1" });
    expect(out.issues).toEqual([]);
  });

  it("does not trust ids across source systems; falls back to code + clinical day", () => {
    const out = dedupePatient([row("a", {}), row("b", { sourceSystem: "other-ehr", format: "CCDA", sourceDate: "2024-03-05T23:00:00.000Z" })]);
    expect(linkOf(out, "b")).toMatchObject({ duplicateOfId: "a", matchedBy: "content", dedupeKey: `code:Condition/${SCT}|59621000/2024-03-05` });
  });

  it("keeps same-day repeats within one source apart and leaves ambiguous content matches unlinked", () => {
    const out = dedupePatient([
      row("a1", { fhirId: "x1", sourceRecordId: "s1" }),
      row("a2", { fhirId: "x2", sourceRecordId: "s1" }),
      row("b", { fhirId: "y", sourceRecordId: "s2", sourceSystem: "other-ehr" }),
    ]);
    expect(out.links.every((l) => l.duplicateOfId === null && l.matchedBy === null)).toBe(true);
  });

  it("never links rows without a code or date by content", () => {
    const out = dedupePatient([row("a", { code: null }), row("b", { fhirId: "z", sourceSystem: "x", code: null })]);
    expect(out.links.map((l) => l.duplicateOfId)).toEqual([null, null]);
  });

  it("flags id-matched duplicates whose codes disagree", () => {
    const out = dedupePatient([row("b", {}), row("c", { format: "CCDA", code: "38341003" })]);
    expect(linkOf(out, "c").duplicateOfId).toBe("b");
    expect(out.issues).toMatchObject([{ severity: "WARNING", code: "duplicate_conflict", details: { code: `${SCT}|38341003` } }]);
  });
});
