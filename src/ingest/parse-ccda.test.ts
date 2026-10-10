import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCcda, prune } from "@/ingest/parse-ccda";

const xml = readFileSync(join(process.cwd(), "fixtures/ingest/ccda-small.xml"), "utf8");

describe("parseCcda", () => {
  const r = parseCcda(xml);
  const get = (id: string) => r.resources.find((x) => x.resource.id === id)!.resource as Record<string, unknown>;

  it("converts every supported entry and attributes it to the document patient", () => {
    expect(r.resources.map((x) => `${x.resource.resourceType}/${x.resource.id}`)).toEqual([
      "Patient/p-ccda-1",
      "Condition/cond-ccda-1",
      "AllergyIntolerance/al-ccda-1",
      "Observation/obs-ccda-1",
      "Observation/obs-ccda-2",
      "MedicationStatement/med-ccda-1",
      "Immunization/imm-ccda-1",
      "Encounter/enc-ccda-1",
    ]);
    expect(r.resources.every((x) => x.sourcePatientId === "p-ccda-1")).toBe(true);
    expect(r.resources[1]!.sourcePath).toBe("/ClinicalDocument/component/structuredBody/component[1]/section/entry[1]/act");
  });

  it("maps the header to Patient with US Core race", () => {
    expect(get("p-ccda-1")).toMatchObject({
      gender: "male",
      birthDate: "1970-01-02",
      name: [{ family: "Testcase2", given: ["Synth"] }],
      identifier: [{ system: "https://example.org/test", value: "p-ccda-1" }],
      extension: [{ url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-race" }],
    });
  });

  it("maps problems with status, translations and source time precision", () => {
    expect(get("cond-ccda-1")).toMatchObject({
      clinicalStatus: { coding: [{ code: "resolved" }] },
      code: {
        coding: [
          { system: "http://snomed.info/sct", code: "44054006" },
          { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9" },
        ],
      },
      onsetDateTime: "2020-01-01T12:00:00-05:00",
      abatementDateTime: "2021-01-01",
    });
  });

  it("maps allergies with substance, type/category, reaction and severity", () => {
    expect(get("al-ccda-1")).toMatchObject({
      clinicalStatus: { coding: [{ code: "active" }] },
      type: "allergy",
      category: ["medication"],
      code: { coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980" }] },
      reaction: [{ manifestation: [{ text: "Hives" }], severity: "severe" }],
    });
  });

  it("maps results, medications, immunizations and encounters", () => {
    expect(get("obs-ccda-1")).toMatchObject({
      status: "final",
      category: [{ coding: [{ code: "laboratory" }] }],
      effectiveDateTime: "2024-03-01T08:30:00Z",
      valueQuantity: { value: 104.5, unit: "mg/dL", system: "http://unitsofmeasure.org" },
    });
    expect(get("med-ccda-1")).toMatchObject({ status: "active", effectivePeriod: { start: "2023-01-01" } });
    expect(get("med-ccda-1").effectivePeriod).not.toHaveProperty("end");
    expect(get("imm-ccda-1")).toMatchObject({ status: "completed", occurrenceDateTime: "2023-10-15", vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx" }] } });
    expect(get("enc-ccda-1")).toMatchObject({ status: "finished", class: { code: "UNK" }, period: { end: "2024-03-01T09:00:00Z" } });
  });

  it("reports data-quality findings instead of guessing", () => {
    const found = r.issues.map((i) => `${i.severity}:${i.code}`);
    expect(found.filter((c) => c.startsWith("WARNING")).sort()).toEqual([
      "WARNING:invalid_value", // bad TS
      "WARNING:invalid_value", // ST template placeholder
      "WARNING:unknown_code_system",
      "WARNING:unmapped_section", // plan of care entry
    ]);
    expect(found).toContain("INFO:timezone_assumed_utc");
    expect(found).toContain("INFO:defaulted_field");
    expect(get("obs-ccda-2")).not.toHaveProperty("valueString");
    expect(get("obs-ccda-2")).toMatchObject({ code: { coding: [{ system: "urn:oid:1.2.3.4.5" }] } });
    expect(r.issues.find((i) => i.code === "unknown_code_system")).toMatchObject({ resourceType: "Observation", fhirId: "obs-ccda-2" });
  });

  it("returns a parse_error for malformed or non-C-CDA XML", () => {
    expect(parseCcda("<ClinicalDocument><x></ClinicalDocument>").issues[0]).toMatchObject({ severity: "ERROR", code: "parse_error" });
    expect(parseCcda("<Other/>").issues[0]).toMatchObject({ severity: "ERROR", code: "parse_error" });
  });
});

describe("prune", () => {
  it("removes undefined, empty strings, arrays and objects", () => {
    expect(prune({ a: undefined, b: "", c: [], d: {}, e: [{ f: undefined }], g: 0, h: false, i: ["x"] })).toEqual({ g: 0, h: false, i: ["x"] });
  });
});
