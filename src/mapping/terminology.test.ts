import { describe, expect, it } from "vitest";
import cvx from "@/mapping/terminology/cvx.json";
import loinc from "@/mapping/terminology/loinc.json";
import rxnorm from "@/mapping/terminology/rxnorm.json";
import snomed from "@/mapping/terminology/snomed.json";
import { loincCheckValid, verhoeffValid } from "@/mapping/terminology/format";
import {
  formatProblem,
  localTerminology,
  normalizeCode,
  ucumCode,
  UCUM_UNITS,
} from "@/mapping/terminology";
import { SNOMED_TO_ICD10CM } from "@/mapping/terminology/snomed-icd10cm";
import { normalizeSystem, SYSTEM } from "@/mapping/systems";

describe("normalizeSystem", () => {
  it.each([
    ["urn:oid:2.16.840.1.113883.6.96", SYSTEM.SNOMED],
    ["2.16.840.1.113883.6.1", SYSTEM.LOINC],
    ["http://snomed.info/sct/731000124108", SYSTEM.SNOMED],
    ["http://snomed.info/sct/731000124108/version/20250301", SYSTEM.SNOMED],
    ["https://loinc.org/", SYSTEM.LOINC],
    ["HTTP://LOINC.ORG", SYSTEM.LOINC],
    ["RxNorm", SYSTEM.RXNORM],
    [" http://hl7.org/fhir/sid/cvx ", SYSTEM.CVX],
    ["urn:oid:1.2.3.4", "urn:oid:1.2.3.4"],
    ["http://example.org/local-codes", "http://example.org/local-codes"],
  ])("%s -> %s", (input, expected) => expect(normalizeSystem(input)).toBe(expected));
});

describe("check digits", () => {
  it("Verhoeff accepts the textbook example and rejects a transposition", () => {
    expect(verhoeffValid("2363")).toBe(true);
    expect(verhoeffValid("2336")).toBe(false);
  });
  it("LOINC mod-10 matches published codes", () => {
    for (const c of ["2345-7", "718-7", "8480-6", "29463-7"]) expect(loincCheckValid(c)).toBe(true);
    expect(loincCheckValid("2345-6")).toBe(false);
  });
  it("formatProblem explains bad codes and ignores unknown systems", () => {
    expect(formatProblem(SYSTEM.SNOMED, "44054006")).toBeNull();
    expect(formatProblem(SYSTEM.SNOMED, "44054007")).toMatch(/check digit/);
    expect(formatProblem(SYSTEM.SNOMED, "44054016")).toMatch(/not a concept id/);
    expect(formatProblem(SYSTEM.LOINC, "4548-4")).toBeNull();
    expect(formatProblem(SYSTEM.LOINC, "4548")).toMatch(/nnnnn-c/);
    expect(formatProblem(SYSTEM.RXNORM, "RX123")).toMatch(/numeric/);
    expect(formatProblem(SYSTEM.ICD10CM, "E11.9")).toBeNull();
    expect(formatProblem(SYSTEM.ICD10CM, "E119")).toMatch(/ICD-10-CM/);
    expect(formatProblem(SYSTEM.ICD10CM, "11.9")).toMatch(/ICD-10-CM/);
    expect(formatProblem("http://example.org", "anything")).toBeNull();
  });
});

describe("normalizeCode", () => {
  it("restores the ICD-10-CM dot and trims everything", () => {
    expect(normalizeCode(SYSTEM.ICD10CM, "e119")).toBe("E11.9");
    expect(normalizeCode(SYSTEM.ICD10CM, "T7840XA")).toBe("T78.40XA");
    expect(normalizeCode(SYSTEM.ICD10CM, "I10")).toBe("I10");
    expect(normalizeCode(SYSTEM.SNOMED, " 44054006 ")).toBe("44054006");
  });
});

describe("committed tables", () => {
  it.each([snomed, loinc, rxnorm, cvx].map((t) => [t.system, t] as const))(
    "every %s code is well-formed with a display",
    (_, t) => {
      for (const [code, display] of Object.entries(t.codes)) {
        expect(formatProblem(t.system, code), code).toBeNull();
        expect(display, code).not.toBe("");
      }
    },
  );

  it("crosswalk keys are known SNOMED concepts and targets are well-formed ICD-10-CM", () => {
    for (const [code, target] of Object.entries(SNOMED_TO_ICD10CM)) {
      expect(localTerminology.lookup(SYSTEM.SNOMED, code).status, code).toBe("known");
      if (target) expect(formatProblem(SYSTEM.ICD10CM, target.code), target.code).toBeNull();
    }
  });
});

describe("localTerminology", () => {
  it("separates known, unknown, malformed and unsupported", () => {
    expect(localTerminology.lookup(SYSTEM.SNOMED, "59621000")).toEqual({
      status: "known",
      display: "Essential hypertension (disorder)",
    });
    expect(localTerminology.lookup(SYSTEM.SNOMED, "22298006").status).toBe("unknown");
    expect(localTerminology.lookup(SYSTEM.SNOMED, "22298007").status).toBe("malformed");
    expect(localTerminology.lookup(SYSTEM.CPT, "99213").status).toBe("unsupported_system");
  });
  it("tells a missing crosswalk entry apart from 'no diagnosis code applies'", () => {
    expect(localTerminology.icd10cm("59621000")).toEqual({
      code: "I10",
      display: "Essential (primary) hypertension",
    });
    expect(localTerminology.icd10cm("160903007")).toBeNull();
    expect(localTerminology.icd10cm("422650009")).toBeUndefined();
  });
});

describe("ucumCode", () => {
  it("accepts UCUM codes and known aliases only", () => {
    expect(ucumCode("mm[Hg]")).toBe("mm[Hg]");
    expect(ucumCode(" mmHg ")).toBe("mm[Hg]");
    expect(ucumCode("lbs")).toBe("[lb_av]");
    expect(ucumCode("furlongs")).toBeUndefined();
    for (const u of Object.keys(UCUM_UNITS)) expect(ucumCode(u)).toBe(u);
  });
});
