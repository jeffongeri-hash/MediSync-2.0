import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNdjson } from "@/ingest/parse-fhir";
import { bundlesToNdjson, sharedReferenceIndex } from "@/ingest/to-ndjson";

const bundle = readFileSync(join(process.cwd(), "fixtures/ingest/bundle-small.json"), "utf8");
const shared = JSON.stringify({
  resourceType: "Bundle",
  entry: [{ resource: { resourceType: "Practitioner", id: "dr-1", identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "9990000001" }] } }],
});

describe("bundlesToNdjson", () => {
  const out = bundlesToNdjson([bundle], sharedReferenceIndex([shared]));

  it("writes one file per canonical type and drops out-of-scope types", () => {
    expect(Object.keys(out)).toEqual(["Patient", "Condition", "Observation", "Procedure", "Encounter"]);
    expect(out.Condition!.endsWith("\n")).toBe(true);
  });

  it("emits literal references that the NDJSON parser can attribute", () => {
    expect(out.Encounter).toContain('"Practitioner/dr-1"');
    const parsed = parseNdjson(out.Condition!);
    expect(parsed.issues).toEqual([]);
    expect(parsed.resources[0]!.sourcePatientId).toBe("p-0001");
  });
});
