import { toCanonical } from "@/canonical";
import { ccdaToDrafts } from "@/ingest/ccda/parse";
import { sourcePatientIdOf, type ParseResult } from "@/ingest/parse-fhir";

/** Drops undefined values, empty strings, empty arrays and empty objects (FHIR forbids empty elements). */
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = v.map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === "object") {
    const o = Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (prune(x) === undefined ? [] : [[k, prune(x)]])));
    return Object.keys(o).length ? o : undefined;
  }
  return v === "" ? undefined : v;
}

/** C-CDA document -> validated canonical resources, with the same issue model as the FHIR parsers. */
export function parseCcda(rawText: string): ParseResult {
  const { drafts, issues } = ccdaToDrafts(rawText);
  const out: ParseResult = { resources: [], issues: [...issues] };
  for (const d of drafts) {
    const { resource, issues: found } = toCanonical(prune(d.resource), d.path);
    out.issues.push(...found);
    if (resource) out.resources.push({ resource, sourcePath: d.path, sourcePatientId: sourcePatientIdOf(resource) });
  }
  return out;
}
