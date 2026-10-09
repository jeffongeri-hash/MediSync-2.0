import { createHash } from "node:crypto";
import { z } from "zod";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const humanName = z.object({
  use: z.string().optional(),
  given: z.array(z.string()).optional(),
  family: z.string().optional(),
});

const patientFields = z.object({
  id: z.string(),
  name: z.array(humanName).optional(),
  birthDate: z.string().optional(),
  gender: z.string().optional(),
});

const bundleSchema = z.object({
  resourceType: z.literal("Bundle"),
  id: z.string().optional(),
  type: z.string(),
  entry: z
    .array(
      z.object({
        resource: z.looseObject({ resourceType: z.string(), id: z.string().optional() }),
      }),
    )
    .default([]),
});

export type BundlePatient = {
  id: string;
  displayName: string | null;
  birthDate: string | null;
  gender: string | null;
};

export type FhirBundleSummary = {
  bundleId: string | null;
  bundleType: string;
  entryCount: number;
  resourceCounts: Record<string, number>;
  patient: BundlePatient | null;
};

function displayName(names: z.infer<typeof humanName>[] | undefined): string | null {
  const name = names?.find((n) => n.use === "official") ?? names?.[0];
  if (!name) return null;
  const text = [...(name.given ?? []), name.family].filter(Boolean).join(" ");
  return text || null;
}

/** Light summary of a FHIR R4 Bundle for indexing. Full parsing and validation is Phase 1. */
export function summarizeFhirBundle(rawText: string): FhirBundleSummary {
  const bundle = bundleSchema.parse(JSON.parse(rawText));
  const resourceCounts: Record<string, number> = {};
  for (const { resource } of bundle.entry) {
    resourceCounts[resource.resourceType] = (resourceCounts[resource.resourceType] ?? 0) + 1;
  }
  const patients = bundle.entry.filter((e) => e.resource.resourceType === "Patient");
  if (patients.length > 1) throw new Error("Bundle contains more than one Patient");
  const p = patients[0] ? patientFields.parse(patients[0].resource) : undefined;
  return {
    bundleId: bundle.id ?? null,
    bundleType: bundle.type,
    entryCount: bundle.entry.length,
    resourceCounts: Object.fromEntries(Object.entries(resourceCounts).sort(([a], [b]) => a.localeCompare(b))),
    patient:
      p
        ? { id: p.id, displayName: displayName(p.name), birthDate: p.birthDate ?? null, gender: p.gender ?? null }
        : null,
  };
}

export type CcdaSummary = {
  title: string | null;
  effectiveTime: string | null;
  sectionCount: number;
};

/** Header-level summary of a C-CDA document. Not a parser; real XML parsing is Phase 1. */
export function summarizeCcda(rawText: string): CcdaSummary {
  if (!/<ClinicalDocument[\s>]/.test(rawText)) throw new Error("Not a C-CDA ClinicalDocument");
  const header = rawText.split(/<component[\s>]/)[0] ?? rawText;
  return {
    title: header.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() || null,
    effectiveTime: header.match(/<effectiveTime\s+value="([^"]+)"/)?.[1] ?? null,
    sectionCount: rawText.match(/<section[\s>/]/g)?.length ?? 0,
  };
}

const SYNTHEA_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(json|xml)$/;

/** Synthea names patient files `<Given>_<Family>_<uuid>.<ext>`; the uuid is the Patient.id. */
export function syntheaPatientIdFromFilename(filename: string): string | null {
  return filename.match(SYNTHEA_FILE)?.[1] ?? null;
}
