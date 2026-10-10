import { describe, expect, it } from "vitest";
import { patientLines, renderIngestReport, type ReportInput } from "@/ingest/report";

const input: ReportInput = {
  patients: [{ id: "u1", sourcePatientId: "abcdef12-0000" }],
  canonical: [
    { patientId: "u1", format: "FHIR_BUNDLE", count: 5 },
    { patientId: "u1", format: "CCDA", count: 4 },
  ],
  issues: [
    { patientId: "u1", filename: null, format: "CCDA", severity: "INFO", code: "timezone_assumed_utc", rows: 1, occurrences: 7, example: "UTC assumed" },
    { patientId: "u1", filename: null, format: "CCDA", severity: "WARNING", code: "invalid_value", rows: 2, occurrences: 2, example: "a | b" },
    { patientId: null, filename: "Observation.ndjson", format: "FHIR_NDJSON", severity: "ERROR", code: "parse_error", rows: 1, occurrences: 1, example: "bad line" },
  ],
  generatedAt: new Date("2026-01-01T00:00:00Z"),
  parserVersion: "t",
};

describe("ingest report", () => {
  it("summarises canonical counts and issue occurrences per patient by id prefix", () => {
    expect(patientLines(input)).toEqual([
      { patient: "abcdef12", canonical: { FHIR_BUNDLE: 5, FHIR_NDJSON: 0, CCDA: 4 }, issues: { ERROR: 0, WARNING: 2, INFO: 7 } },
    ]);
  });

  it("renders markdown with per-code and unattached-source sections", () => {
    const md = renderIngestReport(input);
    expect(md).toContain("fully ingested in all three formats: 0");
    expect(md).toContain("Issue occurrences: ERROR 1, WARNING 2, INFO 7");
    expect(md).toContain("| `abcdef12` | 5 | 0 | 4 | 0 | 2 | 7 |");
    expect(md).toContain("| WARNING | `invalid_value` | C-CDA | 2 | 2 | a \\| b |");
    expect(md).toContain("| `Observation.ndjson` | NDJSON | 1 | 0 | 0 |");
    expect(md.indexOf("ERROR | `parse_error`")).toBeLessThan(md.indexOf("WARNING | `invalid_value`"));
  });
});
