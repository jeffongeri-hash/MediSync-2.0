import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanonicalResource } from "@/canonical";
import { parseFhirBundle } from "@/ingest/parse-fhir";
import {
  clinicalDate,
  DERIVED_CODING_EXT,
  mapResource,
  toInstant,
  type MapResult,
} from "@/mapping/map-resource";
import { SYSTEM } from "@/mapping/systems";
import { localTerminology } from "@/mapping/terminology";

const parsed = parseFhirBundle(
  readFileSync(join(process.cwd(), "fixtures/mapping/bundle-mapping.json"), "utf8"),
);
const byId = new Map(parsed.resources.map((r) => [r.resource.id, r.resource]));
const medications = new Map(
  parsed.resources
    .filter((r) => r.resource.resourceType === "Medication")
    .map((r) => [`Medication/${r.resource.id}`, r.resource]),
);
const ctx = {
  sourceRecordId: "00000000-0000-4000-8000-000000000001",
  sourceSystem: "fixture",
  terminology: localTerminology,
  medications,
};
const map = (id: string): MapResult => mapResource(byId.get(id)!, ctx);
const coding = (r: CanonicalResource, field = "code") =>
  ((r as Record<string, unknown>)[field] as { coding: Record<string, unknown>[] }).coding;

describe("mapResource on the mapping fixture", () => {
  it("parses the fixture cleanly", () => {
    expect(parsed.issues.filter((i) => i.severity !== "INFO")).toEqual([]);
    expect(byId.size).toBe(15);
  });

  it("maps a known SNOMED condition, fills its display, adds a derived ICD-10-CM coding and provenance", () => {
    const r = map("cond-known");
    expect(r.status).toBe("MAPPED");
    expect(r.primary).toEqual({ system: SYSTEM.SNOMED, code: "59621000" });
    expect(r.issues).toEqual([]);
    expect(r.sourceDate).toBe("2024-03-05T10:00:00.000Z");
    const [snomed, icd] = coding(r.mapped);
    expect(snomed!.display).toBe("Essential hypertension (disorder)");
    expect(icd).toMatchObject({
      system: SYSTEM.ICD10CM,
      code: "I10",
      extension: [{ url: DERIVED_CODING_EXT }],
    });
    expect(r.mapped.meta).toEqual({ source: `urn:medisync:source:fixture#${ctx.sourceRecordId}` });
  });

  it("never touches the input resource", () => {
    const before = JSON.stringify(byId.get("cond-known"));
    map("cond-known");
    expect(JSON.stringify(byId.get("cond-known"))).toBe(before);
  });

  it("separates 'no ICD-10-CM code applies' (INFO) from 'not in the crosswalk' (WARNING)", () => {
    expect(map("cond-social").issues).toMatchObject([{ severity: "INFO", code: "no_target_code" }]);
    const r = map("cond-no-xwalk");
    expect(r.status).toBe("MAPPED");
    expect(r.issues).toMatchObject([
      { severity: "WARNING", code: "unmapped_code", details: { target: "ICD-10-CM" } },
    ]);
  });

  it("sends codes outside the tables, malformed codes and wrong systems to review", () => {
    expect(map("cond-unknown")).toMatchObject({
      status: "UNMAPPED",
      issues: [{ code: "unmapped_code", message: /not in the local terminology table/ }],
    });
    const typo = map("cond-oid-typo");
    expect(typo).toMatchObject({
      status: "UNMAPPED",
      primary: { system: SYSTEM.SNOMED, code: "59621001" },
    });
    expect(typo.issues[0]!.message).toMatch(/check digit/);
    expect(map("obs-bad-check").issues[0]!.message).toMatch(/LOINC check digit/);
    expect(map("proc-cpt")).toMatchObject({
      status: "UNMAPPED",
      issues: [{ message: "Procedure has no SNOMED CT code (found CPT)" }],
    });
  });

  it("normalizes an aliased ICD-10-CM-only condition and a partial onset date", () => {
    const r = map("cond-icd-only");
    expect(r).toMatchObject({
      status: "MAPPED",
      primary: { system: SYSTEM.ICD10CM, code: "I10" },
      sourceDate: "2021-01-01T00:00:00.000Z",
    });
    expect(coding(r.mapped)).toEqual([
      { system: SYSTEM.ICD10CM, code: "I10", display: "Essential (primary) hypertension" },
    ]);
  });

  it("resolves medicationReference to the Medication's RxNorm code and flags a dangling one", () => {
    const r = map("mr-ref");
    expect(r).toMatchObject({
      status: "MAPPED",
      primary: { system: SYSTEM.RXNORM, code: "314076" },
      issues: [],
    });
    expect((r.mapped as Record<string, unknown>).medicationReference).toEqual({
      reference: "Medication/med-1",
    });
    expect(map("mr-dangling")).toMatchObject({
      status: "NO_CODE",
      issues: [{ code: "unresolved_reference" }],
    });
    expect(map("med-1")).toMatchObject({ status: "MAPPED", sourceDate: null });
  });

  it("normalizes unit aliases to UCUM and reports unknown units", () => {
    const r = map("obs-bp");
    const comps = (
      r.mapped as unknown as { component: { valueQuantity: Record<string, unknown> }[] }
    ).component;
    expect(comps[0]!.valueQuantity).toEqual({
      value: 120,
      unit: "mmHg",
      system: SYSTEM.UCUM,
      code: "mm[Hg]",
    });
    expect(comps[1]!.valueQuantity).toEqual({ value: 80, unit: "furlongs" });
    expect(r.issues).toMatchObject([
      {
        code: "unmapped_unit",
        path: "Observation.component[1].valueQuantity",
        details: { unit: "furlongs" },
      },
    ]);
    expect(r.status).toBe("MAPPED");
  });

  it("maps Immunization (CVX), Encounter (first type) and Patient", () => {
    expect(map("imm-1")).toMatchObject({
      status: "MAPPED",
      primary: { system: SYSTEM.CVX, code: "140" },
    });
    expect(map("enc-1")).toMatchObject({
      status: "MAPPED",
      primary: { system: SYSTEM.SNOMED, code: "185349003" },
      sourceDate: "2024-03-05T09:30:00.000Z",
    });
    expect(map("p-0002")).toMatchObject({ status: "NOT_APPLICABLE", primary: null, issues: [] });
  });

  it("is idempotent: mapping the mapped copy changes nothing but provenance it already has", () => {
    for (const id of byId.keys()) {
      const once = map(id).mapped;
      expect(mapResource(once, ctx).mapped, id).toEqual(once);
    }
  });
});

describe("dates", () => {
  it("expands partial dates and rejects garbage", () => {
    expect(toInstant("2020-03")).toBe("2020-03-01T00:00:00.000Z");
    expect(toInstant("2020-03-04T05:06:07-05:00")).toBe("2020-03-04T10:06:07.000Z");
    expect(toInstant("not a date")).toBeNull();
    expect(clinicalDate({ resourceType: "Patient" })).toBeNull();
  });
});
