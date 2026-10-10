// Regenerates fixtures/synthea/ndjson from the committed Synthea bundles (Bulk Data style, one file per type).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundlesToNdjson, sharedReferenceIndex } from "@/ingest/to-ndjson";

const root = resolve(process.argv[2] ?? "fixtures/synthea");
const fhirDir = join(root, "fhir");
const files = readdirSync(fhirDir).filter((f) => f.endsWith(".json")).sort();
const texts = files.map((f) => readFileSync(join(fhirDir, f), "utf8"));
const isShared = (t: string) => !t.includes('"resourceType": "Patient"') && !t.includes('"resourceType":"Patient"');

const out = bundlesToNdjson(texts.filter((t) => !isShared(t)), sharedReferenceIndex(texts.filter(isShared)));
const outDir = join(root, "ndjson");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [type, body] of Object.entries(out)) writeFileSync(join(outDir, `${type}.ndjson`), body);
console.log(`ndjson: ${Object.keys(out).length} files written to ${outDir}`);
