// Prints the mapping coverage report (Markdown) for the Synthea source; writes it to a file when a path is given.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDb } from "@/db";
import { MAPPING_VERSION } from "@/mapping/map-resource";
import { loadMappingReportInput, renderMappingReport } from "@/mapping/report";
import { SYNTHEA_SOURCE } from "@/ingest/seed";

const out = process.argv[2];
const db = createDb();

loadMappingReportInput(db, SYNTHEA_SOURCE, MAPPING_VERSION)
  .then((input) => {
    const md = renderMappingReport(input);
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), md);
      console.log(`mapping report written to ${out}`);
    } else {
      process.stdout.write(md);
    }
  })
  .catch((err: unknown) => {
    console.error("mapping report failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
