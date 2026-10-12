// Loads a patient's reconcile rows: the Bundle primaries (current chart) and the C-CDA copies (incoming), mapped.
import type { Db } from "@/db";
import type { Prisma } from "@/generated/prisma/client";
import { RECONCILE_TYPES, type ReconcileType, type SourceRow } from "@/reconcile/rows";

/**
 * Phase 5 (SMART launch): the current chart is exactly one source record (the EHR read at launch) and the incoming
 * record is another patient index row's C-CDA (the outside record the provider picked).
 */
export type RowScope = { currentSourceRecordId: string; incomingPatientId: string };

export async function loadSourceRows(db: Db, patientId: string, scope?: RowScope): Promise<SourceRow[]> {
  if (!scope) return queryRows(db, { patientId, sourceRecord: { format: { in: ["FHIR_BUNDLE", "CCDA"] } } });
  const current = await queryRows(db, { patientId, sourceRecordId: scope.currentSourceRecordId, sourceRecord: { format: "FHIR_BUNDLE" } });
  const incoming = await queryRows(db, { patientId: scope.incomingPatientId, sourceRecord: { format: "CCDA" } });
  // One record is the whole current chart, so its rows are primaries whatever earlier launches they duplicate.
  return [...current.map((r) => ({ ...r, duplicateOfId: null })), ...incoming];
}

async function queryRows(db: Db, where: Prisma.CanonicalResourceWhereInput): Promise<SourceRow[]> {
  const rows = await db.canonicalResource.findMany({
    where: {
      ...where,
      resourceType: { in: [...RECONCILE_TYPES] },
      mapped: { not: { equals: null } },
    },
    orderBy: [{ resourceType: "asc" }, { fhirId: "asc" }, { id: "asc" }],
    select: {
      id: true,
      resourceType: true,
      duplicateOfId: true,
      codeSystem: true,
      code: true,
      mapped: true,
      sourceRecord: { select: { format: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    resourceType: r.resourceType as ReconcileType,
    format: r.sourceRecord.format,
    duplicateOfId: r.duplicateOfId,
    codeSystem: r.codeSystem,
    code: r.code,
    resource: r.mapped as Record<string, unknown>,
  }));
}

/** The latest encounter date in the patient's Bundle, which anchors the default cutoff. */
export async function lastEncounter(db: Db, patientId: string): Promise<Date | null> {
  const r = await db.canonicalResource.aggregate({
    where: {
      patientId,
      resourceType: "Encounter",
      duplicateOfId: null,
      sourceRecord: { format: "FHIR_BUNDLE" },
    },
    _max: { sourceDate: true },
  });
  return r._max.sourceDate;
}
