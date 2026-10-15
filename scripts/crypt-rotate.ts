// pnpm crypt:rotate: seals plaintext raw_text and bundles with the current data key and re-seals older keys.
import "dotenv/config";
import { createDb } from "@/db";
import { rotateSealed } from "@/security/rotate";

const db = createDb();
rotateSealed(db)
  .then((r) =>
    console.log(`crypt:rotate: ${r.sourceRecords} source records, ${r.bundles} bundles re-sealed`),
  )
  .catch((err: unknown) => {
    console.error("crypt:rotate failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
