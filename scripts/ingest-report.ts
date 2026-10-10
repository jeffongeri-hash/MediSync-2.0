// Prints the ingest issue report (Markdown) for the Synthea source; writes it to a file when a path is given.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDb } from "@/db";
import { PARSER_VERSION } from "@/ingest/ingest";
import { loadReportInput, renderIngestReport } from "@/ingest/report";
import { SYNTHEA_SOURCE } from "@/ingest/seed";

const out = process.argv[2];
const db = createDb();

loadReportInput(db, SYNTHEA_SOURCE, PARSER_VERSION)
  .then((input) => {
    const md = renderIngestReport(input);
    if (out) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), md);
      console.log(`ingest report written to ${out}`);
    } else {
      process.stdout.write(md);
    }
  })
  .catch((err: unknown) => {
    console.error("ingest report failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
