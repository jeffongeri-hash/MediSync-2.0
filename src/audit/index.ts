import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { AuditAction } from "@/generated/prisma/enums";

/** One audit entry. `details` is for ids, counts and reasons only, never PHI. */
export const auditEntrySchema = z.object({
  actor: z.string().min(1),
  action: z.enum(AuditAction),
  patientId: z.uuid().nullish(),
  entityType: z.string().min(1),
  entityId: z.string().nullish(),
  source: z.string().nullish(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullish(),
});

export type AuditEntry = z.input<typeof auditEntrySchema>;

type AuditWriter = { auditLog: { createMany(args: { data: Prisma.AuditLogCreateManyInput[] }): Promise<unknown> } };

export async function recordAudit(db: AuditWriter, entries: AuditEntry | AuditEntry[]): Promise<void> {
  const list = (Array.isArray(entries) ? entries : [entries]).map((e) => auditEntrySchema.parse(e));
  if (list.length === 0) return;
  await db.auditLog.createMany({
    data: list.map((e) => ({ ...e, details: e.details ?? undefined })),
  });
}
