// Loads a patient's reconcile rows: the Bundle primaries (current chart) and the C-CDA copies (incoming), mapped.
import type { Db } from "@/db";
import { RECONCILE_TYPES, type ReconcileType, type SourceRow } from "@/reconcile/rows";

export async function loadSourceRows(db: Db, patientId: string): Promise<SourceRow[]> {
  const rows = await db.canonicalResource.findMany({
    where: {
      patientId,
      resourceType: { in: [...RECONCILE_TYPES] },
      mapped: { not: { equals: null } },
      sourceRecord: { format: { in: ["FHIR_BUNDLE", "CCDA"] } },
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
