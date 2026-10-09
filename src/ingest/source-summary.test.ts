import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sha256,
  summarizeCcda,
  summarizeFhirBundle,
  syntheaPatientIdFromFilename,
} from "@/ingest/source-summary";

const bundle = (entries: object[]) =>
  JSON.stringify({ resourceType: "Bundle", type: "transaction", entry: entries.map((resource) => ({ resource })) });

describe("summarizeFhirBundle", () => {
  it("counts resources by type and extracts the patient", () => {
    const s = summarizeFhirBundle(
      bundle([
        {
          resourceType: "Patient",
          id: "p1",
          name: [{ use: "official", given: ["Ada"], family: "Test" }],
          birthDate: "1980-02-03",
          gender: "female",
        },
        { resourceType: "Condition", id: "c1" },
        { resourceType: "Condition", id: "c2" },
        { resourceType: "Organization", id: "o1", name: "Org names are strings" },
      ]),
    );
    expect(s.entryCount).toBe(4);
    expect(s.resourceCounts).toEqual({ Condition: 2, Organization: 1, Patient: 1 });
    expect(s.patient).toEqual({ id: "p1", displayName: "Ada Test", birthDate: "1980-02-03", gender: "female" });
  });

  it("returns no patient for reference-data bundles", () => {
    expect(summarizeFhirBundle(bundle([{ resourceType: "Practitioner", id: "x" }])).patient).toBeNull();
  });

  it("rejects non-bundles and multi-patient bundles", () => {
    expect(() => summarizeFhirBundle(JSON.stringify({ resourceType: "Patient" }))).toThrow();
    expect(() =>
      summarizeFhirBundle(bundle([{ resourceType: "Patient", id: "a" }, { resourceType: "Patient", id: "b" }])),
    ).toThrow(/more than one Patient/);
  });
});

describe("summarizeCcda", () => {
  it("reads header fields and counts sections", () => {
    const xml = `<ClinicalDocument xmlns="urn:hl7-org:v3"><title>Summary</title><effectiveTime value="20260101"/>
      <component><structuredBody><component><section><title>Allergies</title></section></component>
      <component><section/></component></structuredBody></component></ClinicalDocument>`;
    expect(summarizeCcda(xml)).toEqual({ title: "Summary", effectiveTime: "20260101", sectionCount: 2 });
  });

  it("rejects documents that are not C-CDA", () => {
    expect(() => summarizeCcda("<html></html>")).toThrow();
  });
});

describe("syntheaPatientIdFromFilename", () => {
  it("extracts the trailing uuid", () => {
    expect(syntheaPatientIdFromFilename("Jesús825_Garza151_bb526ae3-e675-70a8-a705-4b25707d3ce0.json")).toBe(
      "bb526ae3-e675-70a8-a705-4b25707d3ce0",
    );
    expect(syntheaPatientIdFromFilename("hospitalInformation1791586440492.json")).toBeNull();
  });
});

describe("sha256", () => {
  it("hashes bytes and strings identically", () => {
    expect(sha256("abc")).toBe(sha256(Buffer.from("abc")));
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("Synthea fixtures", () => {
  const dir = join(process.cwd(), "fixtures/synthea");
  const fhir = readdirSync(join(dir, "fhir")).filter((f) => syntheaPatientIdFromFilename(f));
  const ccda = readdirSync(join(dir, "ccda"));

  it("has 10 patients with matching FHIR and C-CDA files", () => {
    expect(fhir).toHaveLength(10);
    expect(ccda.map(syntheaPatientIdFromFilename).sort()).toEqual(fhir.map(syntheaPatientIdFromFilename).sort());
  });

  it.each(fhir)("%s summarizes with Patient.id matching its filename", (file) => {
    const s = summarizeFhirBundle(readFileSync(join(dir, "fhir", file), "utf8"));
    expect(s.patient?.id).toBe(syntheaPatientIdFromFilename(file));
    expect(s.resourceCounts.Encounter).toBeGreaterThan(0);
  });
});
