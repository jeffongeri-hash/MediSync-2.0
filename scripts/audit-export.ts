// Prints audit_log as NDJSON. Same rows as GET /api/audit, without the HTTP role check (operator on the host).
import "dotenv/config";
import { createDb } from "@/db";
import { auditNdjson, exportAudit } from "@/audit/export";

const db = createDb();
exportAudit(db, { limit: 5000 })
  .then((rows) => process.stdout.write(auditNdjson(rows)))
  .catch((err: unknown) => {
    console.error("audit export failed:", err instanceof Error ? err.name : "Error");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
