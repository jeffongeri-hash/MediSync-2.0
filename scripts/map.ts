import "dotenv/config";
import { createDb } from "@/db";
import { runMapping } from "@/mapping/run";

// Usage: pnpm map [--all]   (--all re-maps rows already at the current mapping version)
const db = createDb();

runMapping(db, { actor: "system:map", all: process.argv.includes("--all") })
  .then((r) => console.log(`map: ${r.patients} patients, ${r.mapped} resources mapped, ${r.duplicatesLinked} duplicates linked, ${r.issues} issues raised`))
  .catch((err: unknown) => {
    console.error("map failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
