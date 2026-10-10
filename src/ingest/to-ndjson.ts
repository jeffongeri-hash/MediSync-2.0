import { CANONICAL_TYPES, isCanonicalType } from "@/canonical";
import { indexBundleEntries, rewriteReferences, type ReferenceIndex } from "@/ingest/references";

type RawBundle = { entry?: { fullUrl?: string; resource: { resourceType: string; id?: string } }[] };

/** Reference index over bundles that hold shared resources (Synthea hospital/practitioner files). */
export function sharedReferenceIndex(rawBundles: string[]): ReferenceIndex {
  const index: ReferenceIndex = new Map();
  for (const raw of rawBundles) indexBundleEntries((JSON.parse(raw) as RawBundle).entry ?? [], index);
  return index;
}

/**
 * Converts patient bundles into Bulk Data style NDJSON: one file per resource type, literal "Type/id" references,
 * limited to the canonical types (like `$export?_type=...`). Resources are otherwise unchanged.
 */
export function bundlesToNdjson(patientBundles: string[], shared: ReferenceIndex): Record<string, string> {
  const lines: Record<string, string[]> = {};
  for (const raw of patientBundles) {
    const entries = (JSON.parse(raw) as RawBundle).entry ?? [];
    const index = indexBundleEntries(entries, new Map(shared));
    for (const { resource } of entries) {
      if (!isCanonicalType(resource.resourceType)) continue;
      const { resource: rewritten } = rewriteReferences(resource, index, "");
      (lines[resource.resourceType] ??= []).push(JSON.stringify(rewritten));
    }
  }
  return Object.fromEntries(CANONICAL_TYPES.filter((t) => lines[t]).map((t) => [t, `${lines[t]!.join("\n")}\n`]));
}
