import { describe, expect, it } from "vitest";
import { ageOn, formatBytes, phase1Counts } from "@/demo/format";

describe("demo formatting", () => {
  it("rolls up Phase 1 resource counts and zero-fills missing types", () => {
    const counts = phase1Counts({ MedicationRequest: 3, MedicationStatement: 1, Observation: 9, Claim: 4 });
    expect(counts).toMatchObject({ Medication: 4, Observation: 9, Condition: 0, DocumentReference: 0 });
    expect(counts).not.toHaveProperty("Claim");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("computes age in whole years around the birthday", () => {
    const born = new Date("1990-06-15");
    expect(ageOn(born, new Date("2026-06-14"))).toBe(35);
    expect(ageOn(born, new Date("2026-06-15"))).toBe(36);
  });
});
