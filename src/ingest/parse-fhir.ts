import { z } from "zod";
import { issue, PATIENT_FIELD, toCanonical, type CanonicalResource, type IngestIssue } from "@/canonical";
import { indexBundleEntries, patientIdOf, rewriteReferences, type ReferenceIndex } from "@/ingest/references";

export type ParsedResource = {
  resource: CanonicalResource;
  /** Location in the raw source: "Bundle.entry[3].resource", "line 12", or an XPath. */
  sourcePath: string;
  /** Patient.id in the source's id space; used to attribute the row to a patient index entry. */
  sourcePatientId: string | null;
};
export type ParseResult = { resources: ParsedResource[]; issues: IngestIssue[] };

export function sourcePatientIdOf(resource: CanonicalResource): string | null {
  if (resource.resourceType === "Patient") return resource.id;
  return patientIdOf((resource as Record<string, unknown>)[PATIENT_FIELD[resource.resourceType]]);
}

/** Shared per-resource step: resolve references, validate, attribute to a patient. */
function parseOne(raw: unknown, path: string, index: ReferenceIndex, out: ParseResult): void {
  const { resource: rewritten, unresolved } = rewriteReferences(raw, index, path);
  const { resource, issues } = toCanonical(rewritten, path);
  out.issues.push(...issues);
  if (!resource) return;
  for (const p of unresolved) {
    out.issues.push(
      issue("WARNING", "unresolved_reference", `${resource.resourceType} reference could not be resolved to Type/id`, {
        path: p,
        resourceType: resource.resourceType,
        fhirId: resource.id,
      }),
    );
  }
  out.resources.push({ resource, sourcePath: path, sourcePatientId: sourcePatientIdOf(resource) });
}

const bundleShape = z.object({
  resourceType: z.literal("Bundle"),
  entry: z.array(z.looseObject({ fullUrl: z.string().optional(), resource: z.looseObject({ resourceType: z.string() }) })).default([]),
});

/**
 * FHIR R4 Bundle (transaction, collection, ...) -> canonical resources. `external` resolves references into
 * other sources, e.g. Synthea's conditional Practitioner/Organization/Location references.
 */
export function parseFhirBundle(rawText: string, external: ReferenceIndex = new Map()): ParseResult {
  const out: ParseResult = { resources: [], issues: [] };
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    out.issues.push(issue("ERROR", "parse_error", "Bundle is not valid JSON"));
    return out;
  }
  const bundle = bundleShape.safeParse(json);
  if (!bundle.success) {
    out.issues.push(issue("ERROR", "parse_error", "Not a FHIR Bundle with entry[].resource"));
    return out;
  }
  const index = indexBundleEntries(bundle.data.entry as Parameters<typeof indexBundleEntries>[0], new Map(external));
  bundle.data.entry.forEach((e, i) => parseOne(e.resource, `Bundle.entry[${i}].resource`, index, out));
  return out;
}

/**
 * FHIR Bulk Data NDJSON (one resource per line) -> canonical resources. A bad line is one issue; the rest of
 * the file still ingests. Bulk output already uses literal "Type/id" references.
 */
export function parseNdjson(rawText: string, external: ReferenceIndex = new Map()): ParseResult {
  const out: ParseResult = { resources: [], issues: [] };
  rawText.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const path = `line ${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      out.issues.push(issue("ERROR", "parse_error", "NDJSON line is not valid JSON", { path }));
      return;
    }
    parseOne(json, path, external, out);
  });
  return out;
}
