import { describe, expect, it } from "vitest";
import { auditNdjson } from "@/audit/export";

describe("auditNdjson", () => {
  it("serializes ids and times and keeps details flat", () => {
    const text = auditNdjson([
      {
        id: 12n,
        occurredAt: new Date("2026-10-15T12:00:00.000Z"),
        actor: "reviewer",
        action: "READ",
        patientId: null,
        entityType: "AuditLog",
        entityId: null,
        source: "audit",
        details: { count: 1 },
      },
    ]);
    expect(text).toBe(
      `${JSON.stringify({
        id: "12",
        occurredAt: "2026-10-15T12:00:00.000Z",
        actor: "reviewer",
        action: "READ",
        patientId: null,
        entityType: "AuditLog",
        entityId: null,
        source: "audit",
        details: { count: 1 },
      })}\n`,
    );
  });

  it("returns an empty body for no rows", () => {
    expect(auditNdjson([])).toBe("");
  });
});
