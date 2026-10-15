import "dotenv/config";
import { resolve } from "node:path";
import { createDb } from "@/db";
import { seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";
import { dataKeys } from "@/security/crypt";
import { rotateSealed } from "@/security/rotate";

const dir = resolve(process.argv[2] ?? "fixtures/synthea");
const db = createDb();

seedSynthea(db, dir)
  .then(async (r) => {
    console.log(
      `seed: ${r.patientsCreated} patients created, ${r.sourceRecordsCreated} source records created, ` +
        `${r.sourcesParsed} parsed (${r.canonicalCreated} canonical resources), ${r.sourceRecordsSkipped} unchanged`,
    );
    const m = await runMapping(db, { actor: "system:seed" });
    console.log(
      `map: ${m.patients} patients, ${m.mapped} resources mapped, ${m.duplicatesLinked} duplicates linked`,
    );
    // Rows written before encryption (or under an older key) are sealed with the current key.
    if (dataKeys()) {
      const c = await rotateSealed(db);
      console.log(
        `crypt: ${c.sourceRecords} source records, ${c.bundles} bundles sealed with the current key`,
      );
    }
  })
  .catch((err: unknown) => {
    console.error("seed failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
