// Dry-run write-back (Phase 5): what accepted or edited reconcile lines WOULD write to the launching EHR, checked
// against its CapabilityStatement. Pure; the package is shown and downloadable, never sent anywhere.
import type { Db } from "@/db";
import { supports, type CapabilitySummary } from "@/smart/capability";

type Json = Record<string, unknown>;

export type WriteDecision = { action: "ACCEPT" | "REJECT" | "EDIT"; editedResource: unknown };

/** One reconcile line with the rows behind it (mapped copies) and its latest decision. */
export type WriteItem = {
  id: string;
  ordinal: number;
  category: string;
  /** SAME, CHANGED, NEW or CURRENT_ONLY (reconcile match kind). */
  match: string;
  display: string;
  current: { resourceType: string; fhirId: string } | null;
  incoming: { resourceType: string; resource: Json } | null;
  decision: WriteDecision | null;
};

export type WriteCandidate = {
  itemId: string;
  ordinal: number;
  category: string;
  display: string;
  decision: "ACCEPT" | "EDIT";
  interaction: "create" | "update";
  resourceType: string;
  /** "fhir": the server declares the interaction; "export-package": it does not, so only the Phase 3 export carries it. */
  path: "fhir" | "export-package";
  reason: string;
};

export type WritePackage = {
  dryRun: true;
  runId: string;
  generatedAt: string;
  capabilityFrom: string | null;
  candidates: WriteCandidate[];
  /** Only the "fhir" candidates, as the transaction a real write-back would send. */
  bundle: {
    resourceType: "Bundle";
    type: "transaction";
    entry: { request: { method: "POST" | "PUT"; url: string }; resource: Json }[];
  };
};

/**
 * The resource as it would be written for the launched patient: no id or meta (the server assigns them), the patient
 * reference pointed at the launched patient, and every other reference reduced to its display, since the outside
 * record's encounters and practitioners do not exist on the target server.
 */
export function retarget(resource: Json, patientRef: string, keepId?: string): Json {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== "object" || node === null) return node;
    const o = node as Json;
    if (typeof o.reference === "string") {
      if (o.reference.startsWith("Patient/")) return { ...o, reference: patientRef };
      const { reference, ...rest } = o;
      return {
        ...rest,
        display:
          (rest.display as string | undefined) ?? `${reference.split("/")[0]} record not included`,
      };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  const { id: _id, meta: _meta, ...rest } = resource;
  void _id;
  void _meta;
  const out = walk(rest) as Json;
  return keepId ? { resourceType: resource.resourceType, id: keepId, ...out } : out;
}

export function buildWritePackage(input: {
  runId: string;
  items: WriteItem[];
  capability: CapabilitySummary | null;
  fhirPatientId: string;
  now: Date;
}): WritePackage {
  const patientRef = `Patient/${input.fhirPatientId}`;
  const candidates: WriteCandidate[] = [];
  const entry: WritePackage["bundle"]["entry"] = [];
  for (const it of input.items) {
    const d = it.decision;
    if (!d || d.action === "REJECT") continue;
    // Accepting a line that is the same on both sides changes nothing.
    if (d.action === "ACCEPT" && it.match === "SAME") continue;
    const body = d.action === "EDIT" ? (d.editedResource as Json | null) : it.incoming?.resource;
    // Accepting a line with no incoming row confirms the current chart: nothing to write.
    if (!body || typeof body.resourceType !== "string") continue;
    const type = body.resourceType;
    const update = !!it.current;
    if (update && it.current!.resourceType !== type) {
      candidates.push({
        ...base(it, d.action),
        interaction: "update",
        resourceType: type,
        path: "export-package",
        reason: `the chart holds this as ${it.current!.resourceType}; a ${type} cannot update it`,
      });
      continue;
    }
    const interaction = update ? "update" : "create";
    const allowed = supports(input.capability, type, interaction);
    candidates.push({
      ...base(it, d.action),
      interaction,
      resourceType: type,
      path: allowed ? "fhir" : "export-package",
      reason: allowed
        ? `server declares ${interaction} for ${type}`
        : input.capability
          ? `server does not declare ${interaction} for ${type}`
          : "server CapabilityStatement not available",
    });
    if (allowed)
      entry.push(
        update
          ? {
              request: { method: "PUT", url: `${type}/${it.current!.fhirId}` },
              resource: retarget(body, patientRef, it.current!.fhirId),
            }
          : { request: { method: "POST", url: type }, resource: retarget(body, patientRef) },
      );
  }
  return {
    dryRun: true,
    runId: input.runId,
    generatedAt: input.now.toISOString(),
    capabilityFrom: input.capability?.iss ?? null,
    candidates,
    bundle: { resourceType: "Bundle", type: "transaction", entry },
  };
}

const base = (it: WriteItem, decision: "ACCEPT" | "EDIT") => ({
  itemId: it.id,
  ordinal: it.ordinal,
  category: it.category,
  display: it.display,
  decision,
});

/** Loads a run's lines, rows and latest decisions for buildWritePackage. */
export async function loadWriteItems(db: Db, runId: string): Promise<WriteItem[]> {
  const run = await db.reconciliationRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      items: {
        orderBy: { ordinal: "asc" },
        include: {
          currentRow: { select: { resourceType: true, fhirId: true } },
          incomingRow: { select: { resourceType: true, mapped: true } },
        },
      },
      decisions: { where: { itemId: { not: null } }, orderBy: { id: "asc" } },
    },
  });
  const latest = new Map<string, (typeof run.decisions)[number]>();
  for (const d of run.decisions) latest.set(d.itemId!, d);
  return run.items.map((it) => {
    const d = latest.get(it.id);
    const row = (it.incoming ?? it.current) as { display?: string } | null;
    return {
      id: it.id,
      ordinal: it.ordinal,
      category: it.category,
      match: it.match,
      display: row?.display ?? "",
      current: it.currentRow
        ? { resourceType: it.currentRow.resourceType, fhirId: it.currentRow.fhirId }
        : null,
      incoming: it.incomingRow?.mapped
        ? { resourceType: it.incomingRow.resourceType, resource: it.incomingRow.mapped as Json }
        : null,
      decision: d ? { action: d.action, editedResource: d.editedResource } : null,
    };
  });
}
