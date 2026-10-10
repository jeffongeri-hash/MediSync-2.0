import { describe, expect, it } from "vitest";
import { renderMappingReport, type MappingReportInput } from "@/mapping/report";
import { SYSTEM } from "@/mapping/systems";

const q = (over: Partial<MappingReportInput["queue"][number]>): MappingReportInput["queue"][number] => ({
  stage: "MAPPING",
  severity: "WARNING",
  code: "unmapped_code",
  format: "FHIR_BUNDLE",
  status: "OPEN",
  resourceType: "Condition",
  target: null,
  codeSystem: SYSTEM.SNOMED,
  codeValue: "22298006",
  display: "Myocardial infarction",
  example: "SNOMED CT code is not in the local terminology table",
  rows: 1,
  ...over,
});

const input: MappingReportInput = {
  codes: [
    { resourceType: "Condition", format: "FHIR_BUNDLE", codeSystem: SYSTEM.SNOMED, code: "59621000", status: "MAPPED", rows: 3 },
    { resourceType: "Condition", format: "CCDA", codeSystem: SYSTEM.SNOMED, code: "59621000", status: "MAPPED", rows: 2 },
    { resourceType: "Condition", format: "FHIR_BUNDLE", codeSystem: SYSTEM.SNOMED, code: "22298006", status: "UNMAPPED", rows: 1 },
    { resourceType: "Condition", format: "FHIR_BUNDLE", codeSystem: SYSTEM.SNOMED, code: "422650009", status: "MAPPED", rows: 2 },
    { resourceType: "Condition", format: "FHIR_BUNDLE", codeSystem: SYSTEM.SNOMED, code: "160903007", status: "MAPPED", rows: 1 },
    { resourceType: "Procedure", format: "FHIR_BUNDLE", codeSystem: SYSTEM.CPT, code: "99213", status: "UNMAPPED", rows: 1 },
    { resourceType: "Observation", format: "FHIR_BUNDLE", codeSystem: null, code: null, status: "NO_CODE", rows: 1 },
    { resourceType: "Patient", format: "FHIR_BUNDLE", codeSystem: null, code: null, status: "NOT_APPLICABLE", rows: 1 },
  ],
  queue: [
    q({}),
    q({ resourceType: "Procedure", codeSystem: SYSTEM.CPT, codeValue: "99213", display: "Office visit", example: "Procedure has no SNOMED CT code (found CPT)" }),
    q({ codeValue: "422650009", display: "Social isolation (finding)", target: "ICD-10-CM", rows: 2, status: "IGNORED" }),
    q({ severity: "INFO", code: "no_target_code", codeValue: "160903007", display: "Full-time employment (finding)" }),
  ],
  icd: [{ format: "FHIR_BUNDLE", snomedConditions: 4, withIcd: 3, derived: 3 }],
  units: [{ format: "FHIR_BUNDLE", quantities: 10, ucum: 9 }],
  dedupe: [
    { format: "FHIR_BUNDLE", rows: 5, primaries: 5, byId: 0, byContent: 0 },
    { format: "CCDA", rows: 2, primaries: 0, byId: 1, byContent: 1 },
  ],
  notQueued: { unmappedRows: 0, conditionsWithoutIcd: 0 },
  generatedAt: new Date("2026-01-01T00:00:00Z"),
  mappingVersion: "t",
};

describe("mapping coverage report", () => {
  it("reports % mapped by resource type, format and code system, excluding types without a primary code", () => {
    const md = renderMappingReport(input);
    expect(md).toContain("- Coded resources: 11; primary code mapped: 8 (72.7%); unmapped: 2; no code: 1");
    expect(md).toContain("| Condition | 9 | 8 | 1 | 0 | 88.9% | 4 | 85.7% | – | 100.0% |");
    expect(md).toContain("| SNOMED CT | Condition | 9 | 8 | 88.9% | 4 |");
    expect(md).toContain("| CPT | Procedure | 1 | 0 | 0.0% | 1 |");
    expect(md).toContain("| (none) | Observation | 1 | 0 | 0.0% | 0 |");
    expect(md).not.toMatch(/\| Patient \|/);
  });

  it("lists every unmapped code with its reason, and counts open vs closed queue rows", () => {
    const md = renderMappingReport(input);
    expect(md).toContain("| Condition | SNOMED CT | `22298006` | Myocardial infarction | Bundle | 1 | SNOMED CT code is not in the local terminology table |");
    expect(md).toContain("| Condition | SNOMED CT | `422650009` | Social isolation (finding) | Bundle | 2 | not in ICD-10-CM crosswalk |");
    expect(md).toContain("| MAPPING | WARNING | `unmapped_code` | 4 | 2 | 3 |");
    expect(md).toContain("Distinct mapped SNOMED CT Condition concepts: 3; 1 with an ICD-10-CM code, 1 where none applies, 1 not in the crosswalk");
    expect(md).toContain("| All | 7 | 5 | 1 | 1 |");
    expect(md).toContain("(pass)");
  });

  it("fails the gate line when an unmapped finding is missing from the queue", () => {
    expect(renderMappingReport({ ...input, notQueued: { unmappedRows: 1, conditionsWithoutIcd: 0 } })).toContain("review queue: 1 (FAIL)");
  });
});
