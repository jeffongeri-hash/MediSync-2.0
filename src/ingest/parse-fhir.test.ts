import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFhirBundle, parseNdjson } from "@/ingest/parse-fhir";

const fixture = (name: string) => readFileSync(join(process.cwd(), "fixtures/ingest", name), "utf8");
const codes = (r: { issues: { severity: string; code: string }[] }) => r.issues.map((i) => `${i.severity}:${i.code}`);

describe("parseFhirBundle", () => {
  const external = new Map([["Practitioner?identifier=http://hl7.org/fhir/sid/us-npi|9990000001", "Practitioner/dr-1"]]);
  const r = parseFhirBundle(fixture("bundle-small.json"), external);
  const byId = Object.fromEntries(r.resources.map((x) => [x.resource.id, x]));

  it("keeps valid in-scope resources with source paths and patient attribution", () => {
    expect(Object.keys(byId).sort()).toEqual(["cond-1", "enc-1", "p-0001", "proc-1"]);
    expect(byId["cond-1"]).toMatchObject({ sourcePath: "Bundle.entry[2].resource", sourcePatientId: "p-0001" });
    expect(byId["p-0001"]!.sourcePatientId).toBe("p-0001");
  });

  it("rewrites urn:uuid and conditional references to Type/id", () => {
    expect(byId["cond-1"]!.resource).toMatchObject({ subject: { reference: "Patient/p-0001" }, encounter: { reference: "Encounter/enc-1" } });
    expect(JSON.stringify(byId["enc-1"]!.resource)).toContain('"Practitioner/dr-1"');
  });

  it("reports invalid, unresolved, uncoded and out-of-scope items without dropping the rest", () => {
    expect(codes(r).sort()).toEqual([
      "ERROR:schema_invalid",
      "INFO:unsupported_resource",
      "WARNING:missing_code",
      "WARNING:unresolved_reference",
    ]);
    expect(r.issues.find((i) => i.code === "unresolved_reference")).toMatchObject({
      fhirId: "proc-1",
      path: "Bundle.entry[4].resource.encounter.reference",
    });
  });

  it("warns on conditional references when no external index is given", () => {
    const bare = parseFhirBundle(fixture("bundle-small.json"));
    expect(bare.issues.filter((i) => i.code === "unresolved_reference")).toHaveLength(2);
  });

  it("returns a parse_error for non-JSON or non-Bundle input", () => {
    expect(codes(parseFhirBundle("{nope"))).toEqual(["ERROR:parse_error"]);
    expect(codes(parseFhirBundle('{"resourceType":"Patient"}'))).toEqual(["ERROR:parse_error"]);
  });
});

describe("parseNdjson", () => {
  const r = parseNdjson(fixture("bulk-mixed.ndjson"));

  it("ingests good lines and isolates bad ones by line number", () => {
    expect(r.resources.map((x) => x.resource.id)).toEqual(["p-0002", "imm-1", "al-1"]);
    expect(r.resources[1]).toMatchObject({ sourcePath: "line 2", sourcePatientId: "p-0002" });
    expect(r.issues.map((i) => `${i.path} ${i.severity}:${i.code}`)).toEqual([
      "line 4 ERROR:parse_error",
      "line 5.patient.reference WARNING:unresolved_reference",
      "line 6 ERROR:schema_invalid",
    ]);
  });

  it("cannot attribute a resource whose patient reference is unresolved", () => {
    expect(r.resources[2]!.sourcePatientId).toBeNull();
  });
});
