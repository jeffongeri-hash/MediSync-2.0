import { describe, expect, it } from "vitest";
import {
  entryUuid,
  fullUrlFor,
  rewriteReferences,
  sha256,
  transactionBundleSchema,
} from "@/export/bundle";
import { completeness, diffResource, duplicateOnlyPatterns, flatten, pattern } from "@/export/diff";
import { SOURCE_DOCUMENT_SYSTEM } from "@/export/provenance";
import { renderFidelityReport, summarize } from "@/export/report";
import { planTransfer, type ExportRow } from "@/export/transfer";
import { AT, FIXTURE_SHA, fixtureRows } from "../../tests/helpers/export-rows";

type Json = Record<string, unknown>;
const rows = fixtureRows();
const plan = planTransfer(rows, AT);
const outcome = (type: string, id: string) =>
  plan.outcomes.find((o) => o.resourceType === type && o.fhirId === id)!;
const entryFor = (type: string, id: string) =>
  plan.bundle!.entry.find((e) => e.fullUrl === fullUrlFor(`${type}/${id}`))?.resource as
    Json | undefined;

describe("entryUuid", () => {
  it("is a deterministic RFC 9562 version 8 UUID", () => {
    expect(entryUuid("Patient/p")).toBe(entryUuid("Patient/p"));
    expect(entryUuid("Patient/p")).not.toBe(entryUuid("Patient/q"));
    expect(entryUuid("Patient/p")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("rewriteReferences", () => {
  it("points in-bundle references at entries and keeps only the display of the others", () => {
    const r = {
      subject: { reference: "Patient/p" },
      performer: [{ reference: "Practitioner/x", display: "Dr. A" }],
      reason: { reference: "Condition/gone" },
      contained: { reference: "#c1" },
    };
    const dropped = rewriteReferences(
      r,
      new Map([["Patient/p", "urn:uuid:1"]]),
      (t) => t === "Condition",
    );
    expect(r).toEqual({
      subject: { reference: "urn:uuid:1" },
      performer: [{ display: "Dr. A" }],
      reason: { display: "Condition record not included in this transfer" },
      contained: { reference: "#c1" },
    });
    expect(dropped).toEqual([
      { path: "performer[0]", targetType: "Practitioner", reason: "outside_scope" },
      { path: "reason", targetType: "Condition", reason: "not_exported" },
    ]);
  });
});

describe("planTransfer (fixture)", () => {
  it("exports every resource but the one failing a mandatory check, each with one Provenance", () => {
    expect(plan.blockers).toEqual([]);
    expect(plan.outcomes.filter((o) => !o.exported).map((o) => o.fhirId)).toEqual(["cond-nocat"]);
    expect(plan.provenanceCount).toBe(rows.length - 1);
    expect(plan.bundle!.entry).toHaveLength(2 * (rows.length - 1));
    expect(entryFor("Condition", "cond-nocat")).toBeUndefined();
  });

  it("produces a valid transaction bundle: POSTs, no ids, every reference resolvable, Patient first", () => {
    expect(transactionBundleSchema.safeParse(plan.bundle).success).toBe(true);
    const types = plan.bundle!.entry.map((e) => e.resource.resourceType);
    expect(types[0]).toBe("Patient");
    expect(types.slice(rows.length - 1).every((t) => t === "Provenance")).toBe(true);
    expect(plan.bundleText!.includes('"Patient/')).toBe(false);
    expect(plan.bundleSha256).toBe(sha256(plan.bundleText!));
  });

  it("is byte-identical for the same rows and export time, in any input order", () => {
    expect(planTransfer([...rows].reverse(), AT).bundleText).toBe(plan.bundleText);
    expect(planTransfer(rows, "2026-10-12T00:00:00Z").bundleSha256).not.toBe(plan.bundleSha256);
  });

  it("drops references to excluded or out-of-scope targets and keeps their display", () => {
    const proc = entryFor("Procedure", "proc-1")!;
    expect(proc.reasonReference).toEqual([{ display: "Acute bronchitis (disorder)" }]);
    expect(proc.location).toEqual({ display: "Fixture Clinic" });
    expect(
      outcome("Procedure", "proc-1")
        .dropped.map((d) => d.reason)
        .sort(),
    ).toEqual(["not_exported", "outside_scope"]);
    expect(entryFor("Encounter", "enc-1")!.serviceProvider).toEqual({
      display: "Organization record not included in this transfer",
    });
    expect(entryFor("MedicationRequest", "mr-1")!.medicationReference).toEqual({
      reference: fullUrlFor("Medication/med-1"),
    });
  });

  it("cites the source document and every linked duplicate in Provenance", () => {
    const withDup: ExportRow[] = rows.map((r) =>
      r.fhirId === "alg-1"
        ? {
            ...r,
            duplicates: [
              {
                resourceType: r.resourceType,
                fhirId: r.fhirId,
                resource: r.resource,
                source: { format: "CCDA", sourceSystem: "fixture", sha256: "c".repeat(64) },
              },
            ],
          }
        : r,
    );
    const b = planTransfer(withDup, AT).bundle!;
    const prov = b.entry.find(
      (e) => e.fullUrl === fullUrlFor("Provenance:AllergyIntolerance/alg-1"),
    )!.resource as Json;
    expect(prov.target).toEqual([{ reference: fullUrlFor("AllergyIntolerance/alg-1") }]);
    expect(prov.recorded).toBe(AT);
    expect(
      (prov.entity as { what: { identifier: { system: string; value: string } } }[]).map(
        (e) => e.what.identifier,
      ),
    ).toEqual([
      { system: SOURCE_DOCUMENT_SYSTEM, value: FIXTURE_SHA },
      { system: SOURCE_DOCUMENT_SYSTEM, value: "c".repeat(64) },
    ]);
  });

  it("raises EXPORT issues: one ERROR per excluded resource, WARNINGs for must-support and missing profiles", () => {
    const byCode = (c: string) =>
      plan.issues
        .filter((i) => i.code === c)
        .map((i) => i.fhirId)
        .sort();
    expect(byCode("profile_violation")).toEqual(["cond-nocat"]);
    expect(byCode("no_target_profile")).toEqual(["ms-1"]);
    expect(byCode("profile_must_support")).toEqual(["enc-1", "mr-1", "p-0003"]);
    expect(plan.issues.find((i) => i.code === "profile_violation")!.severity).toBe("ERROR");
    expect(JSON.stringify(plan.issues)).not.toContain("Fixture321"); // types and element names only, no PHI
  });

  it("blocks the bundle when the Patient fails its profile", () => {
    const noGender = rows.map((r) =>
      r.resourceType === "Patient"
        ? { ...r, mapped: { ...r.mapped, gender: undefined } as typeof r.mapped }
        : r,
    );
    const blocked = planTransfer(noGender, AT);
    expect(blocked.blockers).toEqual(["Patient lacks US Core mandatory element(s): gender"]);
    expect(blocked.bundle).toBeNull();
    expect(blocked.bundleSha256).toBeNull();
  });
});

describe("diff", () => {
  it("flattens leaves with indexed paths and skips identity and metadata", () => {
    const f = flatten({
      resourceType: "X",
      id: "1",
      meta: { a: 1 },
      code: { coding: [{ system: "s" }] },
      n: 2,
      ok: false,
    });
    expect([...f.entries()]).toEqual([
      ["code.coding[0].system", '"s"'],
      ["n", "2"],
      ["ok", "false"],
    ]);
    expect(pattern("a[0].b[12].c")).toBe("a[].b[].c");
  });

  it("classifies kept, changed, lost and added elements with reasons", () => {
    const source = {
      code: { coding: [{ system: "urn:oid:2.16.840.1.113883.6.96", code: "1" }] },
      subject: { reference: "Patient/p" },
      performer: [{ reference: "Practitioner/x", display: "Dr. A" }],
      valueQuantity: { value: 5, unit: "mg/dL" },
      note: "free text",
    };
    const exported = {
      code: { coding: [{ system: "http://snomed.info/sct", code: "1", display: "Thing" }] },
      subject: { reference: "urn:uuid:1" },
      performer: [{ display: "Dr. A" }],
      valueQuantity: {
        value: 5,
        unit: "mg/dL",
        system: "http://unitsofmeasure.org",
        code: "mg/dL",
      },
      note: "other text",
    };
    const d = diffResource(source, exported, [
      { path: "performer[0]", targetType: "Practitioner", reason: "outside_scope" },
    ]);
    expect(d.sourceLeaves).toBe(8);
    expect(d.kept).toBe(4);
    expect(d.changed).toEqual([
      {
        pattern: "code.coding[].system",
        reason: "system_normalized",
        example: "urn:oid:2.16.840.1.113883.6.96 -> http://snomed.info/sct",
      },
      {
        pattern: "subject.reference",
        reason: "reference_rewritten",
        example: "Patient/<id> -> urn:uuid:<entry>",
      },
      { pattern: "note", reason: "value_changed", example: undefined }, // free text is never echoed
    ]);
    expect(d.lost).toEqual([
      {
        pattern: "performer[].reference",
        reason: "reference_outside_scope",
        example: "Practitioner",
      },
    ]);
    expect(d.added.map((a) => a.reason)).toEqual(["display_filled", "ucum_coded", "ucum_coded"]);
    expect(completeness({ ...d, changed: d.changed.length })).toBe(7 / 8);
  });

  it("counts every leaf of an excluded resource as lost", () => {
    const d = diffResource({ a: 1, b: { c: 2 } }, null);
    expect(d.lost.map((l) => l.reason)).toEqual(["resource_excluded", "resource_excluded"]);
    expect(completeness({ ...d, changed: 0 })).toBe(0);
  });

  it("finds elements only a duplicate has, treating choice variants as one element", () => {
    const primary = { performedPeriod: { start: "2024" }, code: { text: "x" } };
    const dup = {
      performedDateTime: "2024",
      code: { text: "x" },
      reaction: [{ severity: "mild" }],
    };
    expect(duplicateOnlyPatterns(primary, dup)).toEqual(["reaction[].severity"]);
  });
});

describe("fidelity report", () => {
  const report = renderFidelityReport({
    plan,
    dryRun: true,
    patient: { sourceSystem: "fixture", sourcePatientId: "p-0003" },
    openIssues: [{ stage: "MAPPING", severity: "WARNING", code: "unmapped_code", count: 2 }],
  });

  it("summarizes per type and overall", () => {
    const { overall, byType } = summarize(plan);
    expect(overall.selected).toBe(rows.length);
    expect(overall.excluded).toBe(1);
    expect(byType.map((t) => t.type)[0]).toBe("Patient");
    expect(byType.reduce((s, t) => s + t.sourceLeaves, 0)).toBe(overall.sourceLeaves);
    expect(overall.completeness).toBeGreaterThan(0.85);
    expect(overall.completeness).toBeLessThan(1);
  });

  it("renders every section, deterministically, without patient names", () => {
    for (const h of [
      "## Summary",
      "## Findings",
      "## By resource type",
      "## What would be lost",
      "## What would change",
      "## Added by the transfer",
      "## Available only in a linked duplicate",
      "## Conformance",
      "## Open review-queue items",
      "## Caveats",
    ]) {
      expect(report).toContain(h);
    }
    expect(report).toContain("**Dry run**");
    expect(report).toContain("| Condition | `cond-nocat` | `category` |");
    expect(report).toContain("`reasonCode` or `reasonReference`"); // a "|" would split the table cell
    expect(report).not.toMatch(/Fixture321|Export789/);
    expect(
      renderFidelityReport({
        plan: planTransfer(rows, AT),
        dryRun: true,
        patient: { sourceSystem: "fixture", sourcePatientId: "p-0003" },
        openIssues: [{ stage: "MAPPING", severity: "WARNING", code: "unmapped_code", count: 2 }],
      }),
    ).toBe(report);
  });

  it("explains what a blocked transfer is missing", () => {
    const blocked = planTransfer(
      rows.filter((r) => r.resourceType !== "Patient"),
      AT,
    );
    const md = renderFidelityReport({
      plan: blocked,
      dryRun: false,
      patient: { sourceSystem: "fixture", sourcePatientId: "p-0003" },
      openIssues: [],
    });
    expect(md).toContain("## Blocked");
    expect(md).toContain("expected exactly one Patient, found 0");
  });
});
