import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@/db";
import { ingestSource, type IngestOutcome, type SourceInput } from "@/ingest/ingest";
import { summarizeCcda, summarizeFhirBundle } from "@/ingest/source-summary";
import { sharedReferenceIndex } from "@/ingest/to-ndjson";

export const SYNTHEA_SOURCE = "synthea";

export type SeedResult = {
  patientsCreated: number;
  sourceRecordsCreated: number;
  sourceRecordsSkipped: number;
  sourcesParsed: number;
  canonicalCreated: number;
};

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(ext)).sort();
}

/**
 * Loads Synthea output (fhir/*.json, ndjson/*.ndjson, ccda/*.xml): raw sources untouched, canonical resources,
 * mapping issues and audit entries. Idempotent: sources are keyed by sha256, patients by (source system, Patient.id).
 */
export async function seedSynthea(db: Db, dir: string, actor = "system:seed"): Promise<SeedResult> {
  const result: SeedResult = { patientsCreated: 0, sourceRecordsCreated: 0, sourceRecordsSkipped: 0, sourcesParsed: 0, canonicalCreated: 0 };
  const tally = (o: IngestOutcome) => {
    result.patientsCreated += o.patientsCreated;
    result.canonicalCreated += o.canonicalCount;
    if (o.created) result.sourceRecordsCreated++;
    else if (!o.parsed) result.sourceRecordsSkipped++;
    if (o.parsed) result.sourcesParsed++;
  };
  const base = { sourceSystem: SYNTHEA_SOURCE };

  // FHIR bundles. Shared (no Patient) bundles first: they resolve the patient bundles' conditional references.
  const bundles = await Promise.all(
    (await listFiles(join(dir, "fhir"), ".json")).map(async (filename) => {
      const bytes = await readFile(join(dir, "fhir", filename));
      return { filename, bytes, summary: summarizeFhirBundle(bytes.toString("utf8")) };
    }),
  );
  const shared = bundles.filter((b) => !b.summary.patient);
  const refIndex = sharedReferenceIndex(shared.map((b) => b.bytes.toString("utf8")));
  for (const b of [...shared, ...bundles.filter((x) => x.summary.patient)]) {
    const input: SourceInput = {
      ...base,
      format: "FHIR_BUNDLE",
      filename: b.filename,
      bytes: b.bytes,
      contentType: "application/fhir+json",
      sourceRecordId: b.summary.bundleId,
      summary: b.summary,
      refIndex,
    };
    tally(await ingestSource(db, input, actor));
  }

  // Bulk Data NDJSON: Patient first so other types can be attributed, Medication last (attributed via its requests).
  const rank = (f: string) => (f === "Patient.ndjson" ? 0 : f === "Medication.ndjson" ? 2 : 1);
  const ndjson = (await listFiles(join(dir, "ndjson"), ".ndjson")).sort((a, b) => rank(a) - rank(b));
  for (const filename of ndjson) {
    const bytes = await readFile(join(dir, "ndjson", filename));
    const lineCount = bytes.toString("utf8").split("\n").filter((l) => l.trim()).length;
    const summary = { resourceType: filename.replace(/\.ndjson$/, ""), lineCount };
    tally(await ingestSource(db, { ...base, format: "FHIR_NDJSON", filename, bytes, contentType: "application/fhir+ndjson", summary }, actor));
  }

  for (const filename of await listFiles(join(dir, "ccda"), ".xml")) {
    const bytes = await readFile(join(dir, "ccda", filename));
    const summary = summarizeCcda(bytes.toString("utf8"));
    tally(await ingestSource(db, { ...base, format: "CCDA", filename, bytes, contentType: "application/xml", summary }, actor));
  }

  return result;
}
