// Audit hash chain (Phase 6): verify and export. The insert trigger (migration phase6_audit_chain) sets
// hash = sha256 over the previous row's hash and this row's fields; this file recomputes the same input from an
// exported row, so anyone holding an export can check it without the database.
import { createHash } from "node:crypto";
import { recordAudit } from "@/audit";
import type { Db } from "@/db";

/** One audit row as exported: every field as the text the hash covers (details is the stored JSON text). */
export type AuditRow = {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  patientId: string | null;
  entityType: string;
  entityId: string | null;
  source: string | null;
  details: string | null;
  prevHash: string | null;
  hash: string;
};

const field = (v: string | null) => (v === null ? "-" : `${Buffer.byteLength(v)}:${v}`);

export function auditHash(prev: string | null, r: Omit<AuditRow, "prevHash" | "hash">): string {
  const input = [
    prev,
    r.id,
    r.occurredAt,
    r.actor,
    r.action,
    r.patientId,
    r.entityType,
    r.entityId,
    r.source,
    r.details,
  ]
    .map(field)
    .join("");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type ChainCheck = {
  verified: boolean;
  rows: number;
  head: string | null;
  /** First row whose link or hash does not match. */
  broken: { id: string; reason: "prev_hash" | "hash" } | null;
};

/**
 * Checks rows in id order. `prev` is the hash before the first row: null for a full chain; for a slice (a ranged
 * export), pass the first row's prevHash, which only a full-chain check can confirm.
 */
export function verifyChain(rows: AuditRow[], prev: string | null = null): ChainCheck {
  let expected = prev;
  for (const r of rows) {
    if (r.prevHash !== expected)
      return {
        verified: false,
        rows: rows.length,
        head: expected,
        broken: { id: r.id, reason: "prev_hash" },
      };
    if (auditHash(r.prevHash, r) !== r.hash)
      return {
        verified: false,
        rows: rows.length,
        head: expected,
        broken: { id: r.id, reason: "hash" },
      };
    expected = r.hash;
  }
  return { verified: true, rows: rows.length, head: expected, broken: null };
}

type Range = { from?: Date; to?: Date };

/** Audit rows in id order, as exported. `to` is exclusive. */
export async function readAuditRows(
  db: Pick<Db, "$queryRaw">,
  range: Range = {},
): Promise<AuditRow[]> {
  // occurred_at is a UTC timestamp without zone; compare in UTC whatever the session time zone.
  const from = (range.from ?? new Date(0)).toISOString();
  const to = (range.to ?? new Date("9999-12-31T00:00:00Z")).toISOString();
  return db.$queryRaw<AuditRow[]>`
    SELECT id::text AS "id",
           to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
           actor AS "actor", action::text AS "action", patient_id::text AS "patientId",
           entity_type AS "entityType", entity_id AS "entityId", source AS "source",
           details::text AS "details", prev_hash AS "prevHash", hash AS "hash"
    FROM audit_log
    WHERE occurred_at >= (${from}::timestamptz AT TIME ZONE 'UTC')
      AND occurred_at < (${to}::timestamptz AT TIME ZONE 'UTC')
    ORDER BY audit_log.id`; // not the text alias
}

/** Verifies the whole chain in the database. shortcut: reads every row; checkpoint the head past ~1M rows. */
export async function verifyAuditLog(db: Pick<Db, "$queryRaw">): Promise<ChainCheck> {
  return verifyChain(await readAuditRows(db));
}

/**
 * NDJSON export: one line per row in range, then `{"chain": ...}` with the full-chain check and its head hash.
 * Verifies first, then writes one EXPORT audit entry for the export itself (after the reported head).
 */
export async function exportAudit(
  db: Db,
  input: Range & { actor: string; via: "cli" | "api" },
): Promise<{ ndjson: string; check: ChainCheck; exported: number }> {
  const check = await verifyAuditLog(db);
  const rows = await readAuditRows(db, input);
  const trailer = {
    chain: {
      verified: check.verified,
      rows: check.rows,
      head: check.head,
      broken: check.broken,
      exported: rows.length,
      from: input.from?.toISOString() ?? null,
      to: input.to?.toISOString() ?? null,
    },
  };
  await recordAudit(db, {
    actor: input.actor,
    action: "EXPORT",
    entityType: "AuditLog",
    source: `audit-export:${input.via}`,
    details: {
      rows: rows.length,
      verified: check.verified,
      head: check.head,
      from: trailer.chain.from,
      to: trailer.chain.to,
    },
  });
  const ndjson = [...rows, trailer].map((r) => JSON.stringify(r)).join("\n") + "\n";
  return { ndjson, check, exported: rows.length };
}
