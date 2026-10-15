import type { AuditAction, Prisma } from "@/generated/prisma/client";
import type { Db } from "@/db";

export type AuditExportQuery = {
  since?: Date;
  until?: Date;
  action?: AuditAction;
  limit: number;
};

type AuditRow = {
  id: bigint;
  occurredAt: Date;
  actor: string;
  action: string;
  patientId: string | null;
  entityType: string;
  entityId: string | null;
  source: string | null;
  details: Prisma.JsonValue;
};

/** Audit rows for export. The table has no clinical text; this select keeps it that way. */
export async function exportAudit(
  db: Pick<Db, "auditLog">,
  query: AuditExportQuery,
): Promise<AuditRow[]> {
  return db.auditLog.findMany({
    where: {
      occurredAt: { gte: query.since, lt: query.until },
      action: query.action,
    },
    orderBy: { id: "asc" },
    take: query.limit,
    select: {
      id: true,
      occurredAt: true,
      actor: true,
      action: true,
      patientId: true,
      entityType: true,
      entityId: true,
      source: true,
      details: true,
    },
  });
}

export function auditNdjson(rows: AuditRow[]): string {
  if (rows.length === 0) return "";
  return (
    rows
      .map((row) =>
        JSON.stringify({
          id: row.id.toString(),
          occurredAt: row.occurredAt.toISOString(),
          actor: row.actor,
          action: row.action,
          patientId: row.patientId,
          entityType: row.entityType,
          entityId: row.entityId,
          source: row.source,
          details: row.details,
        }),
      )
      .join("\n") + "\n"
  );
}
