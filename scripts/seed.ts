import "dotenv/config";
import { resolve } from "node:path";
import { createDb } from "@/db";
import { seedSynthea } from "@/ingest/seed";

const dir = resolve(process.argv[2] ?? "fixtures/synthea");
const db = createDb();

seedSynthea(db, dir)
  .then((r) => {
    console.log(
      `seed: ${r.patientsCreated} patients created, ${r.sourceRecordsCreated} source records created, ${r.sourceRecordsSkipped} unchanged`,
    );
  })
  .catch((err: unknown) => {
    console.error("seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
