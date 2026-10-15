import { describe, expect, it } from "vitest";
import { auditHash, verifyChain, type AuditRow } from "@/audit/chain";

function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev: string | null = null;
  for (let i = 1; i <= n; i++) {
    const base = {
      id: String(i),
      occurredAt: `2026-10-15T12:00:0${i}.000Z`,
      actor: "smart:https://ehr.example/fhir/Practitioner/1",
      action: "READ",
      patientId: i % 2 ? "6d1f0c1e-0000-4000-8000-000000000001" : null,
      entityType: "Patient",
      entityId: null,
      source: "demo",
      details: i === 2 ? '{"count": 3}' : null,
    };
    const row: AuditRow = { ...base, prevHash: prev, hash: auditHash(prev, base) };
    rows.push(row);
    prev = row.hash;
  }
  return rows;
}

describe("audit hash chain", () => {
  it("verifies an intact chain and reports its head", () => {
    const rows = chain(5);
    expect(verifyChain(rows)).toEqual({
      verified: true,
      rows: 5,
      head: rows[4]!.hash,
      broken: null,
    });
    expect(verifyChain([])).toMatchObject({ verified: true, head: null });
  });

  it("finds an edited row", () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, actor: "smart:someone-else" };
    expect(verifyChain(rows).broken).toEqual({ id: "3", reason: "hash" });
  });

  it("finds a removed row and a reordered pair", () => {
    const rows = chain(5);
    expect(verifyChain([...rows.slice(0, 2), ...rows.slice(3)]).broken).toEqual({
      id: "4",
      reason: "prev_hash",
    });
    expect(verifyChain([rows[0]!, rows[2]!, rows[1]!, rows[3]!]).broken).toEqual({
      id: "3",
      reason: "prev_hash",
    });
  });

  it("finds a forged row even when its own hash is recomputed", () => {
    const rows = chain(4);
    const forged = { ...rows[1]!, actor: "smart:forger" };
    forged.hash = auditHash(forged.prevHash, forged);
    expect(verifyChain([rows[0]!, forged, rows[2]!, rows[3]!]).broken).toEqual({
      id: "3",
      reason: "prev_hash",
    });
  });

  it("keeps field boundaries: moving text between fields changes the hash", () => {
    const [r] = chain(1);
    expect(auditHash(null, { ...r!, actor: "ab", entityType: "c" })).not.toBe(
      auditHash(null, { ...r!, actor: "a", entityType: "bc" }),
    );
  });

  it("checks a slice from its first row's link when that link is given", () => {
    const rows = chain(5);
    expect(verifyChain(rows.slice(2), rows[2]!.prevHash).verified).toBe(true);
    expect(verifyChain(rows.slice(2)).broken).toEqual({ id: "3", reason: "prev_hash" });
  });
});
