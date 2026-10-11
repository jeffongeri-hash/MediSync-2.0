import { describe, expect, it } from "vitest";
import type { CanonicalResource } from "@/canonical";
import { checkConformance } from "@/export/conformance";
import { profileFor, profileUrl, toUsCore, US_CORE_VERSION } from "@/export/us-core";
import { DERIVED_CODING_EXT } from "@/mapping/map-resource";
import { SYSTEM } from "@/mapping/systems";
import { fixtureRows, rowOf } from "../../tests/helpers/export-rows";

const rows = fixtureRows();
const json = (r: CanonicalResource) => r as unknown as Record<string, unknown>;

describe("profileFor", () => {
  it.each([
    ["Patient", "p-0003", "us-core-patient"],
    ["Encounter", "enc-1", "us-core-encounter"],
    ["Condition", "cond-1", "us-core-condition-encounter-diagnosis"],
    ["Condition", "cond-nocat", "us-core-condition-problems-health-concerns"],
    ["AllergyIntolerance", "alg-1", "us-core-allergyintolerance"],
    ["Medication", "med-1", "us-core-medication"],
    ["MedicationRequest", "mr-1", "us-core-medicationrequest"],
    ["MedicationStatement", "ms-1", null],
    ["Observation", "obs-bp", "us-core-blood-pressure"],
    ["Observation", "obs-lab", "us-core-observation-lab"],
    ["Observation", "obs-smoke", "us-core-smokingstatus"],
    ["Immunization", "imm-1", "us-core-immunization"],
    ["Procedure", "proc-1", "us-core-procedure"],
    ["DocumentReference", "doc-1", "us-core-documentreference"],
  ])("%s/%s -> %s", (type, id, profile) => {
    expect(profileFor(rowOf(rows, type, id).mapped)).toBe(profile);
  });

  it("picks Observation profiles by category and LOINC code", () => {
    const obs = (cat: string, loinc: string) =>
      ({
        resourceType: "Observation",
        id: "o",
        status: "final",
        category: [{ coding: [{ code: cat }] }],
        code: { coding: [{ system: SYSTEM.LOINC, code: loinc }] },
        subject: { reference: "Patient/p" },
      }) as unknown as CanonicalResource;
    expect(profileFor(obs("vital-signs", "72514-3"))).toBe("us-core-vital-signs");
    expect(profileFor(obs("vital-signs", "29463-7"))).toBe("us-core-body-weight");
    expect(profileFor(obs("social-history", "11111-1"))).toBe("us-core-simple-observation");
    expect(profileFor(obs("survey", "93025-5"))).toBe("us-core-observation-screening-assessment");
    expect(profileFor(obs("procedure", "33756-8"))).toBe("us-core-observation-clinical-result");
    expect(profileFor(obs("exam", "75325-1"))).toBe("us-core-simple-observation");
  });
});

describe("toUsCore", () => {
  it("replaces meta with the versioned profile and keeps resourceType first", () => {
    const { resource } = toUsCore(rowOf(rows, "Patient", "p-0003").mapped);
    expect(Object.keys(resource).slice(0, 2)).toEqual(["resourceType", "meta"]);
    expect(resource.meta).toEqual({ profile: [profileUrl("us-core-patient")] });
    expect(profileUrl("us-core-patient")).toMatch(
      new RegExp(`\\|${US_CORE_VERSION.replace(/\./g, "\\.")}$`),
    );
  });

  it("withholds codings derived from the unverified crosswalk and leaves the source codings", () => {
    const mapped = rowOf(rows, "Condition", "cond-1").mapped;
    expect(JSON.stringify(mapped)).toContain(DERIVED_CODING_EXT); // Phase 2 derived an ICD-10-CM coding
    const out = toUsCore(mapped);
    expect(out.withheldDerivedCodings).toBe(1);
    expect(JSON.stringify(out.resource)).not.toContain(DERIVED_CODING_EXT);
    expect(
      (json(out.resource).code as { coding: { system: string }[] }).coding.map((c) => c.system),
    ).toEqual([SYSTEM.SNOMED]);
  });

  it("emits no meta for a type without a US Core profile, and does not mutate its input", () => {
    const mapped = rowOf(rows, "MedicationStatement", "ms-1").mapped;
    const before = JSON.stringify(mapped);
    expect(toUsCore(mapped).resource.meta).toBeUndefined();
    expect(JSON.stringify(mapped)).toBe(before);
  });
});

describe("checkConformance", () => {
  const check = (type: string, id: string) => {
    const us = toUsCore(rowOf(rows, type, id).mapped);
    return checkConformance(us.resource, us.profile);
  };

  it("passes every fixture resource except the Condition without a category", () => {
    for (const r of rows) {
      const us = toUsCore(r.mapped);
      const { missing } = checkConformance(us.resource, us.profile);
      expect(missing, `${r.resourceType}/${r.fhirId}`).toEqual(
        r.fhirId === "cond-nocat" ? ["category"] : [],
      );
    }
  });

  it("reports absent must-support elements", () => {
    expect(check("Patient", "p-0003").mustSupportMissing).toEqual(["communication"]);
    expect(check("MedicationRequest", "mr-1").mustSupportMissing).toEqual(["dosageInstruction"]);
    expect(check("Encounter", "enc-1").mustSupportMissing).toEqual(["reasonCode|reasonReference"]);
  });

  it("applies FHIR cardinality inside arrays and choice elements", () => {
    const patient = {
      resourceType: "Patient",
      identifier: [{ system: "s", value: "1" }, { value: "2" }],
      name: [{ text: "x" }],
      gender: "male",
    };
    expect(checkConformance(patient, "us-core-patient").missing).toEqual([
      "identifier.system",
      "name.family|given",
    ]);
    const vital = {
      resourceType: "Observation",
      status: "final",
      category: [{}],
      code: {},
      subject: {},
      effectivePeriod: { start: "2024" },
    };
    expect(checkConformance(vital, "us-core-heart-rate").missing).toEqual([
      "value[x]|component|dataAbsentReason",
    ]);
    expect(
      checkConformance({ ...vital, dataAbsentReason: { text: "x" } }, "us-core-heart-rate").missing,
    ).toEqual([]);
  });

  it("requires AllergyIntolerance.clinicalStatus unless the record is entered-in-error", () => {
    const base = { resourceType: "AllergyIntolerance", code: {}, patient: {} };
    expect(checkConformance(base, "us-core-allergyintolerance").missing).toEqual([
      "clinicalStatus (unless entered-in-error)",
    ]);
    const eie = { ...base, verificationStatus: { coding: [{ code: "entered-in-error" }] } };
    expect(checkConformance(eie, "us-core-allergyintolerance").missing).toEqual([]);
  });

  it("passes a profile it has no rules for", () => {
    expect(checkConformance({ resourceType: "MedicationStatement" }, null)).toEqual({
      missing: [],
      mustSupportMissing: [],
    });
  });
});
