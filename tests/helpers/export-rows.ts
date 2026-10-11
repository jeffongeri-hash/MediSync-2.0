// Export rows built from fixtures/export/bundle-export.json the way the DB pass builds them: parse, then map.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalResource, CanonicalType } from "@/canonical";
import type { ExportRow } from "@/export/transfer";
import { parseFhirBundle } from "@/ingest/parse-fhir";
import { mapResource } from "@/mapping/map-resource";
import { localTerminology } from "@/mapping/terminology";

export const FIXTURE_SHA = "f".repeat(64);
export const AT = "2026-10-11T00:00:00Z";

export function fixtureRows(): ExportRow[] {
  const parsed = parseFhirBundle(
    readFileSync(join(process.cwd(), "fixtures/export/bundle-export.json"), "utf8"),
  );
  if (parsed.issues.some((i) => i.severity !== "INFO"))
    throw new Error("export fixture must parse cleanly");
  const medications = new Map(
    parsed.resources
      .filter((r) => r.resource.resourceType === "Medication")
      .map((r) => [`Medication/${r.resource.id}`, r.resource]),
  );
  return parsed.resources.map((r) => {
    const resource = r.resource as CanonicalResource;
    const { mapped } = mapResource(resource, {
      sourceRecordId: "00000000-0000-4000-8000-000000000003",
      sourceSystem: "fixture",
      terminology: localTerminology,
      medications,
    });
    return {
      rowId: `row-${resource.resourceType}-${resource.id}`,
      resourceType: resource.resourceType as CanonicalType,
      fhirId: resource.id,
      resource,
      mapped,
      source: { format: "FHIR_BUNDLE", sourceSystem: "fixture", sha256: FIXTURE_SHA },
      duplicates: [],
    };
  });
}

export const rowOf = (rows: ExportRow[], type: string, id: string) => {
  const r = rows.find((x) => x.resourceType === type && x.fhirId === id);
  if (!r) throw new Error(`no fixture row ${type}/${id}`);
  return r;
};
