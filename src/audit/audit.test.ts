import { describe, expect, it, vi } from "vitest";
import { recordAudit } from "@/audit";

describe("recordAudit", () => {
  it("writes validated entries in one batch", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    await recordAudit({ auditLog: { createMany } }, [
      { actor: "u1", action: "READ", entityType: "Patient", entityId: "x" },
      { actor: "u1", action: "CREATE", entityType: "SourceRecord", details: { byteSize: 10 } },
    ]);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it("rejects unknown actions, missing actors and nested details", async () => {
    const createMany = vi.fn();
    const db = { auditLog: { createMany } };
    // @ts-expect-error invalid action on purpose
    await expect(recordAudit(db, { actor: "u", action: "PEEK", entityType: "Patient" })).rejects.toThrow();
    await expect(recordAudit(db, { actor: "", action: "READ", entityType: "Patient" })).rejects.toThrow();
    await expect(
      // @ts-expect-error details are flat scalars only
      recordAudit(db, { actor: "u", action: "READ", entityType: "Patient", details: { name: { given: "x" } } }),
    ).rejects.toThrow();
    expect(createMany).not.toHaveBeenCalled();
  });
});
