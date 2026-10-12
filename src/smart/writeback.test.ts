import { describe, expect, it } from "vitest";
import { summarizeCapability } from "@/smart/capability";
import { buildWritePackage, retarget, type WriteItem } from "@/smart/writeback";

const capability = summarizeCapability(
  {
    resourceType: "CapabilityStatement",
    rest: [
      {
        mode: "server",
        resource: [
          { type: "AllergyIntolerance", interaction: [{ code: "read" }, { code: "create" }] },
          { type: "Condition", interaction: [{ code: "read" }, { code: "update" }] },
          { type: "MedicationStatement", interaction: [{ code: "read" }] },
        ],
      },
    ],
  },
  "https://ehr.example.test/fhir",
);

const allergy = {
  resourceType: "AllergyIntolerance",
  id: "outside-a1",
  meta: { source: "urn:medisync:source:synthea#x" },
  patient: { reference: "Patient/outside-p" },
  encounter: { reference: "Encounter/outside-e" },
  recorder: { reference: "Practitioner/outside-dr", display: "Dr. Outside" },
  code: { text: "Peanut" },
};

const item = (over: Partial<WriteItem>): WriteItem => ({
  id: "i1",
  ordinal: 0,
  category: "ALLERGY",
  display: "Peanut",
  current: null,
  incoming: { resourceType: "AllergyIntolerance", resource: allergy },
  decision: { action: "ACCEPT", editedResource: null },
  ...over,
});

describe("buildWritePackage (dry run)", () => {
  const now = new Date("2026-10-12T00:00:00Z");

  it("creates accepted NEW lines the server allows, for the launched patient, outside references reduced to display", () => {
    const pkg = buildWritePackage({
      runId: "r",
      items: [item({})],
      capability,
      fhirPatientId: "ehr-p",
      now,
    });
    expect(pkg).toMatchObject({ dryRun: true, capabilityFrom: "https://ehr.example.test/fhir" });
    expect(pkg.candidates).toEqual([
      expect.objectContaining({
        interaction: "create",
        resourceType: "AllergyIntolerance",
        path: "fhir",
      }),
    ]);
    expect(pkg.bundle.entry).toEqual([
      {
        request: { method: "POST", url: "AllergyIntolerance" },
        resource: {
          resourceType: "AllergyIntolerance",
          patient: { reference: "Patient/ehr-p" },
          encounter: { display: "Encounter record not included" },
          recorder: { display: "Dr. Outside" },
          code: { text: "Peanut" },
        },
      },
    ]);
  });

  it("updates a CHANGED line in place, routes undeclared interactions to the export package, skips rejects and confirmations", () => {
    const condition = {
      resourceType: "Condition",
      id: "outside-c",
      subject: { reference: "Patient/outside-p" },
      code: { text: "Asthma" },
    };
    const pkg = buildWritePackage({
      runId: "r",
      items: [
        item({
          id: "u",
          current: { resourceType: "Condition", fhirId: "ehr-c" },
          incoming: { resourceType: "Condition", resource: condition },
        }),
        item({ id: "rej", decision: { action: "REJECT", editedResource: null } }),
        item({ id: "none", decision: null }),
        item({
          id: "confirm",
          current: { resourceType: "AllergyIntolerance", fhirId: "ehr-a" },
          incoming: null,
        }),
        item({
          id: "med",
          incoming: {
            resourceType: "MedicationStatement",
            resource: { resourceType: "MedicationStatement", id: "m" },
          },
        }),
        item({
          id: "type",
          current: { resourceType: "MedicationRequest", fhirId: "ehr-m" },
          incoming: {
            resourceType: "MedicationStatement",
            resource: { resourceType: "MedicationStatement", id: "m" },
          },
        }),
      ],
      capability,
      fhirPatientId: "ehr-p",
      now,
    });
    expect(pkg.candidates.map((c) => [c.itemId, c.interaction, c.path])).toEqual([
      ["u", "update", "fhir"],
      ["med", "create", "export-package"],
      ["type", "update", "export-package"],
    ]);
    expect(pkg.bundle.entry).toEqual([
      {
        request: { method: "PUT", url: "Condition/ehr-c" },
        resource: {
          resourceType: "Condition",
          id: "ehr-c",
          subject: { reference: "Patient/ehr-p" },
          code: { text: "Asthma" },
        },
      },
    ]);
  });

  it("uses the edited copy for EDIT, and sends nothing via FHIR without a CapabilityStatement", () => {
    const edited = { ...allergy, code: { text: "Peanut (edited)" } };
    const pkg = buildWritePackage({
      runId: "r",
      items: [item({ decision: { action: "EDIT", editedResource: edited } })],
      capability: null,
      fhirPatientId: "ehr-p",
      now,
    });
    expect(pkg.candidates[0]).toMatchObject({
      decision: "EDIT",
      path: "export-package",
      reason: "server CapabilityStatement not available",
    });
    expect(pkg.bundle.entry).toEqual([]);
    expect(retarget(edited, "Patient/ehr-p").code).toEqual({ text: "Peanut (edited)" });
  });
});
