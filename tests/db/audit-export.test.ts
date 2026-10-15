import { afterAll, describe, expect, it } from "vitest";
import { auditNdjson, exportAudit } from "@/audit/export";
import { recordAudit } from "@/audit";
import { createDb } from "@/db";

describe.skipIf(!process.env.DATABASE_URL)("audit export (database)", () => {
  const db = createDb();
  const actor = `test:audit-export:${Date.now()}`;
  afterAll(() => db.$disconnect());

  it("returns the row that was just written and no clinical text", async () => {
    await recordAudit(db, {
      actor,
      action: "READ",
      entityType: "AuditLog",
      details: { probe: true },
    });
    const since = new Date(Date.now() - 60_000);
    const rows = await exportAudit(db, { since, limit: 50 });
    const mine = rows.filter((row) => row.actor === actor);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: "READ", entityType: "AuditLog", patientId: null });
    expect(auditNdjson(mine)).not.toContain("family");
  });
});
