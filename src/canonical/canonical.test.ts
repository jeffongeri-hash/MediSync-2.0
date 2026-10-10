import { describe, expect, it } from "vitest";
import { aggregateInfo, issue, toCanonical } from "@/canonical";

const subject = { reference: "Patient/p1" };
const snomed = (code: string) => ({ coding: [{ system: "http://snomed.info/sct", code }] });

describe("toCanonical", () => {
  it("accepts a valid in-scope resource and keeps unknown fields", () => {
    const r = toCanonical({ resourceType: "Condition", id: "c1", subject, code: snomed("44054006"), note: [{ text: "x" }] }, "p");
    expect(r.issues).toEqual([]);
    expect(r.resource).toMatchObject({ id: "c1", note: [{ text: "x" }] });
  });

  it("reports out-of-scope types as INFO without a canonical copy", () => {
    const r = toCanonical({ resourceType: "Claim", id: "x" }, "entry[3]");
    expect(r.resource).toBeNull();
    expect(r.issues[0]).toMatchObject({ severity: "INFO", code: "unsupported_resource", resourceType: "Claim", path: "entry[3]" });
  });

  it("rejects schema violations with paths but no values", () => {
    const r = toCanonical({ resourceType: "Observation", id: "o1", status: "done", code: snomed("1"), effectiveDateTime: "2024-01-01T10:00" }, "p");
    expect(r.resource).toBeNull();
    expect(r.issues[0]).toMatchObject({ severity: "ERROR", code: "schema_invalid", fhirId: "o1" });
    expect(r.issues[0]!.message).toMatch(/status/);
    expect(r.issues[0]!.message).toMatch(/effectiveDateTime: invalid FHIR dateTime/);
  });

  it("enforces choice[x] cardinality", () => {
    const both = { resourceType: "MedicationRequest", id: "m", status: "active", intent: "order", subject, medicationCodeableConcept: snomed("1"), medicationReference: { reference: "Medication/1" } };
    expect(toCanonical(both, "p").issues[0]!.message).toMatch(/medication\[x\]: exactly one required/);
    const { medicationCodeableConcept: _a, medicationReference: _b, ...none } = both;
    expect(toCanonical(none, "p").issues[0]!.code).toBe("schema_invalid");
  });

  it("flags a missing or text-only primary code as WARNING but keeps the resource", () => {
    const r = toCanonical({ resourceType: "Procedure", id: "pr", status: "completed", subject, code: { text: "appendectomy" } }, "p");
    expect(r.resource).not.toBeNull();
    expect(r.issues).toEqual([expect.objectContaining({ severity: "WARNING", code: "missing_code", path: "p.code" })]);
  });

  it("does not demand a code for medications given by reference", () => {
    const r = toCanonical({ resourceType: "MedicationRequest", id: "m", status: "active", intent: "order", subject, medicationReference: { reference: "Medication/1" } }, "p");
    expect(r.issues).toEqual([]);
  });

  it("rejects non-resources", () => {
    expect(toCanonical("nope", "line 1").issues[0]).toMatchObject({ severity: "ERROR", code: "schema_invalid" });
  });
});

describe("aggregateInfo", () => {
  it("collapses INFO by code/type/message and keeps WARNING/ERROR per item", () => {
    const out = aggregateInfo([
      issue("INFO", "unsupported_resource", "m", { resourceType: "Claim", path: "a" }),
      issue("WARNING", "missing_code", "w", { path: "b" }),
      issue("INFO", "unsupported_resource", "m", { resourceType: "Claim", path: "c" }),
      issue("WARNING", "missing_code", "w", { path: "d" }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ path: "a", details: { count: 2, firstPath: "a" } });
  });
});
