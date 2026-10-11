// The transfer pipeline as one pure function: a patient's primary canonical rows -> US Core copies -> local
// conformance -> reference rewriting -> transaction Bundle + Provenance, with the element-level diff of every
// resource. A dry run is this plan without keeping the bundle; the DB wrapper is src/export/run.ts.
import {
  canonicalSchemas,
  isCanonicalType,
  issue,
  type CanonicalResource,
  type CanonicalType,
  type IngestIssue,
} from "@/canonical";
import {
  assembleBundle,
  fullUrlFor,
  rewriteReferences,
  serializeBundle,
  sha256,
  type BundleEntry,
  type DroppedReference,
  type TransactionBundle,
} from "@/export/bundle";
import { checkConformance } from "@/export/conformance";
import { diffResource, duplicateOnlyPatterns, type ResourceDiff } from "@/export/diff";
import { provenanceFor, type SourceRef } from "@/export/provenance";
import { TARGET_PROFILE, US_CORE_VERSION, toUsCore } from "@/export/us-core";

type Json = Record<string, unknown>;
export type SourceInfo = Omit<SourceRef, "resourceType" | "fhirId">;

/** A primary row (duplicate_of_id is null) with its `resource` (as received), `mapped` copy and linked duplicates. */
export type ExportRow = {
  rowId: string;
  resourceType: CanonicalType;
  fhirId: string;
  resource: CanonicalResource;
  mapped: CanonicalResource;
  source: SourceInfo;
  duplicates: {
    resourceType: string;
    fhirId: string;
    resource: CanonicalResource;
    source: SourceInfo;
  }[];
};

export type ResourceOutcome = {
  rowId: string;
  resourceType: CanonicalType;
  fhirId: string;
  profile: string | null;
  exported: boolean;
  /** Mandatory profile elements that are missing (non-empty = excluded). */
  missing: string[];
  mustSupportMissing: string[];
  withheldDerivedCodings: number;
  dropped: DroppedReference[];
  diff: ResourceDiff;
  /** Per linked duplicate: element patterns it has that the primary lacks; null when its type differs. */
  duplicateOnly: { format: string; resourceType: string; patterns: string[] | null }[];
};

export type TransferPlan = {
  targetProfile: string;
  exportedAt: string;
  patientFhirId: string | null;
  /** Reasons the transfer cannot produce a bundle (e.g. the Patient fails its profile). */
  blockers: string[];
  outcomes: ResourceOutcome[];
  provenanceCount: number;
  bundle: TransactionBundle | null;
  bundleText: string | null;
  bundleSha256: string | null;
  issues: (IngestIssue & { rowId: string })[];
};

/** Bundle order: Patient, then what others reference, then the rest; Provenance last. */
export const TYPE_ORDER: CanonicalType[] = [
  "Patient",
  "Medication",
  "Encounter",
  "Condition",
  "AllergyIntolerance",
  "MedicationRequest",
  "MedicationStatement",
  "Immunization",
  "Procedure",
  "Observation",
  "DocumentReference",
];
const keyOf = (type: string, id: string) => `${type}/${id}`;

export function planTransfer(rows: ExportRow[], exportedAt: string): TransferPlan {
  const sorted = [...rows].sort(
    (a, b) =>
      TYPE_ORDER.indexOf(a.resourceType) - TYPE_ORDER.indexOf(b.resourceType) ||
      (a.fhirId < b.fhirId ? -1 : a.fhirId > b.fhirId ? 1 : 0),
  );
  const blockers: string[] = [];
  const patients = sorted.filter((r) => r.resourceType === "Patient");
  if (patients.length !== 1)
    blockers.push(`expected exactly one Patient, found ${patients.length}`);

  // 1. US Core copy and local conformance; a missing mandatory element excludes the resource.
  const staged = sorted.map((row) => {
    const us = toUsCore(row.mapped);
    return { row, us, conformance: checkConformance(us.resource, us.profile) };
  });
  const included = staged.filter((s) => !s.conformance.missing.length);
  const patientOut = staged.find(
    (s) => s.row.resourceType === "Patient" && s.conformance.missing.length,
  );
  if (patientOut)
    blockers.push(
      `Patient lacks US Core mandatory element(s): ${patientOut.conformance.missing.join(", ")}`,
    );
  const fullUrls = new Map(
    included.map((s) => [
      keyOf(s.row.resourceType, s.row.fhirId),
      fullUrlFor(keyOf(s.row.resourceType, s.row.fhirId)),
    ]),
  );

  // 2. Rewrite references, re-validate the copy, then build the entries (POST, so no id) and their Provenance.
  const entries: BundleEntry[] = [];
  const provenance: BundleEntry[] = [];
  const outcomes: ResourceOutcome[] = [];
  const issues: TransferPlan["issues"] = [];
  for (const { row, us, conformance } of staged) {
    const type = row.resourceType;
    const at = { resourceType: type, fhirId: row.fhirId, path: type };
    const exported = !conformance.missing.length;
    let body: Json | null = null;
    let dropped: DroppedReference[] = [];
    if (exported) {
      const copy = us.resource as Json;
      dropped = rewriteReferences(copy, fullUrls, isCanonicalType);
      const valid = canonicalSchemas[type].safeParse(copy);
      if (!valid.success) throw new Error(`export copy of ${type} failed canonical validation`);
      body = { ...copy };
      delete body.id; // POST entries: the target assigns ids
      const fullUrl = fullUrls.get(keyOf(type, row.fhirId))!;
      entries.push({ fullUrl, resource: body });
      const sources: SourceRef[] = [
        { ...row.source, resourceType: type, fhirId: row.fhirId },
        ...row.duplicates.map((d) => ({
          ...d.source,
          resourceType: d.resourceType,
          fhirId: d.fhirId,
        })),
      ];
      provenance.push({
        fullUrl: fullUrlFor(`Provenance:${keyOf(type, row.fhirId)}`),
        resource: provenanceFor(fullUrl, exportedAt, sources),
      });
    }
    outcomes.push({
      rowId: row.rowId,
      resourceType: type,
      fhirId: row.fhirId,
      profile: us.profile,
      exported,
      missing: conformance.missing,
      mustSupportMissing: conformance.mustSupportMissing,
      withheldDerivedCodings: us.withheldDerivedCodings,
      dropped,
      diff: diffResource(row.resource as Json, body, dropped),
      duplicateOnly: row.duplicates.map((d) => ({
        format: d.source.format,
        resourceType: d.resourceType,
        patterns:
          d.resourceType === type
            ? duplicateOnlyPatterns(row.resource as Json, d.resource as Json)
            : null,
      })),
    });

    if (!exported) {
      issues.push({
        ...issue(
          "ERROR",
          "profile_violation",
          `${type} lacks US Core mandatory element(s): ${conformance.missing.join(", ")}; not exported`,
          at,
        ),
        details: { profile: us.profile, version: US_CORE_VERSION },
        rowId: row.rowId,
      });
    } else if (!us.profile) {
      issues.push({
        ...issue(
          "WARNING",
          "no_target_profile",
          `${type} has no US Core ${US_CORE_VERSION} profile; exported as base FHIR R4`,
          at,
        ),
        rowId: row.rowId,
      });
    }
    if (exported && conformance.mustSupportMissing.length) {
      issues.push({
        ...issue(
          "WARNING",
          "profile_must_support",
          `${type} has no ${conformance.mustSupportMissing.join(", ")} (US Core must-support)`,
          at,
        ),
        details: { profile: us.profile, version: US_CORE_VERSION },
        rowId: row.rowId,
      });
    }
  }

  // 3. The bundle, unless blocked.
  let bundle: TransactionBundle | null = null;
  let bundleText: string | null = null;
  if (!blockers.length) {
    for (const p of provenance) {
      const c = checkConformance(p.resource, "us-core-provenance");
      if (c.missing.length) throw new Error(`Provenance lacks ${c.missing.join(", ")}`);
    }
    bundle = assembleBundle([...entries, ...provenance], exportedAt);
    bundleText = serializeBundle(bundle);
  }
  return {
    targetProfile: TARGET_PROFILE,
    exportedAt,
    patientFhirId: patients[0]?.fhirId ?? null,
    blockers,
    outcomes,
    provenanceCount: bundle ? provenance.length : 0,
    bundle,
    bundleText,
    bundleSha256: bundleText ? sha256(bundleText) : null,
    issues,
  };
}
