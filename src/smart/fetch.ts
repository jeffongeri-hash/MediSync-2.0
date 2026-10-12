// Reads the launched patient's record from a SMART FHIR server into one Bundle, the shape ingest already accepts.
// Resources are kept exactly as the server returned them; entries are sorted and carry the server's absolute
// fullUrl, so an unchanged chart yields identical bytes (idempotent ingest) and absolute references resolve.
import type { ReadType } from "@/smart/config";

/** GET relative to the FHIR base (or an absolute URL on it), returning parsed JSON. Throws on HTTP errors. */
export type FhirGet = (url: string) => Promise<unknown>;

export type QueryOutcome = {
  /** Stable label, e.g. "Condition:problem-list-item". No patient ids. */
  label: string;
  resourceType: ReadType;
  ok: boolean;
  count: number;
  pages: number;
  /** OperationOutcome entries the server put in the searchset (search.mode "outcome"). */
  outcomes: number;
  /** "http_<status>", "next_link_off_server", "page_limit" or an error class. Never a response body. */
  error?: string;
};

type Resource = { resourceType: string; id?: string; [k: string]: unknown };
type Entry = { fullUrl?: string; resource?: Resource; search?: { mode?: string } };
type SearchBundle = {
  resourceType?: string;
  entry?: Entry[];
  link?: { relation?: string; url?: string }[];
};

export type PatientRecord = {
  bundle: {
    resourceType: "Bundle";
    type: "collection";
    entry: { fullUrl: string; resource: Resource }[];
  };
  bytes: Buffer;
  queries: QueryOutcome[];
};

export class RecordReadError extends Error {
  constructor(
    readonly code: string,
    readonly queries: QueryOutcome[],
  ) {
    super(`Patient record read failed: ${code}`);
  }
}

export const MAX_PAGES = 50;
export const MAX_MEDICATION_READS = 200;

/** Searches per type. Conditions are asked for by US Core category, since some servers require one. */
export function patientQueries(
  patientId: string,
): { label: string; resourceType: ReadType; url: string }[] {
  const p = encodeURIComponent(patientId);
  const conditions = ["problem-list-item", "encounter-diagnosis", "health-concern"].map((c) => ({
    label: `Condition:${c}`,
    resourceType: "Condition" as const,
    url: `Condition?patient=${p}&category=${c}`,
  }));
  return [
    ...conditions,
    {
      label: "MedicationRequest",
      resourceType: "MedicationRequest",
      url: `MedicationRequest?patient=${p}`,
    },
    {
      label: "AllergyIntolerance",
      resourceType: "AllergyIntolerance",
      url: `AllergyIntolerance?patient=${p}`,
    },
    { label: "Encounter", resourceType: "Encounter", url: `Encounter?patient=${p}` },
  ];
}

const errorCode = (e: unknown): string => {
  const status = (e as { status?: unknown })?.status ?? (e as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number") return `http_${status}`;
  return e instanceof Error ? e.name : "unknown_error";
};

/** True when `url` is the FHIR base itself or below it (so the access token may be sent there). */
export function onServer(url: string, iss: string): boolean {
  try {
    const u = new URL(url, `${iss}/`);
    const base = new URL(`${iss}/`);
    return u.origin === base.origin && u.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}

async function search(
  get: FhirGet,
  iss: string,
  q: { label: string; resourceType: ReadType; url: string },
  into: Resource[],
): Promise<QueryOutcome> {
  const out: QueryOutcome = {
    label: q.label,
    resourceType: q.resourceType,
    ok: true,
    count: 0,
    pages: 0,
    outcomes: 0,
  };
  let next: string | undefined = q.url;
  try {
    while (next) {
      if (out.pages >= MAX_PAGES) return { ...out, ok: false, error: "page_limit" };
      const page = (await get(next)) as SearchBundle;
      out.pages++;
      for (const e of page.entry ?? []) {
        if (!e.resource) continue;
        if (e.search?.mode === "outcome" || e.resource.resourceType === "OperationOutcome")
          out.outcomes++;
        else {
          into.push(e.resource);
          if (e.resource.resourceType === q.resourceType) out.count++;
        }
      }
      next = page.link?.find((l) => l.relation === "next")?.url;
      if (next && !onServer(next, iss)) return { ...out, ok: false, error: "next_link_off_server" };
    }
    return out;
  } catch (e) {
    return { ...out, ok: false, error: errorCode(e) };
  }
}

/** "Medication/x" ids referenced by MedicationRequests (relative or absolute on this server) that were not returned. */
export function missingMedications(resources: Resource[], iss: string): string[] {
  const have = new Set(resources.filter((r) => r.resourceType === "Medication").map((r) => r.id));
  const ids = new Set<string>();
  for (const r of resources) {
    if (r.resourceType !== "MedicationRequest") continue;
    const ref = (r.medicationReference as { reference?: unknown } | undefined)?.reference;
    if (typeof ref !== "string" || ref.startsWith("#")) continue;
    const rel = ref.startsWith(`${iss}/`) ? ref.slice(iss.length + 1) : ref;
    const m = /^Medication\/([A-Za-z0-9\-.]{1,64})$/.exec(rel);
    if (m && !have.has(m[1])) ids.add(m[1]!);
  }
  return [...ids].sort();
}

/** Assembles the read into a deterministic collection Bundle: one entry per Type/id, sorted, first copy kept. */
export function assembleBundle(resources: Resource[], iss: string): PatientRecord["bundle"] {
  const byKey = new Map<string, Resource>();
  for (const r of resources) {
    if (!r.id) continue;
    const key = `${r.resourceType}/${r.id}`;
    if (!byKey.has(key)) byKey.set(key, r);
  }
  const keys = [...byKey.keys()].sort();
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: keys.map((k) => ({ fullUrl: `${iss}/${k}`, resource: byKey.get(k)! })),
  };
}

/**
 * Reads Patient, Conditions, MedicationRequests (plus the Medications they reference), AllergyIntolerances and
 * Encounters for one patient. A failed search is reported and the rest still load; a failed Patient read fails all.
 */
export async function readPatientRecord(
  get: FhirGet,
  iss: string,
  patientId: string,
): Promise<PatientRecord> {
  const resources: Resource[] = [];
  const queries: QueryOutcome[] = [];

  const patient: QueryOutcome = {
    label: "Patient",
    resourceType: "Patient",
    ok: true,
    count: 0,
    pages: 1,
    outcomes: 0,
  };
  try {
    const p = (await get(`Patient/${encodeURIComponent(patientId)}`)) as Resource;
    if (p?.resourceType !== "Patient" || p.id !== patientId) throw new Error("unexpected_resource");
    resources.push(p);
    patient.count = 1;
  } catch (e) {
    patient.ok = false;
    patient.error =
      e instanceof Error && e.message === "unexpected_resource"
        ? "unexpected_resource"
        : errorCode(e);
  }
  queries.push(patient);
  if (!patient.ok) throw new RecordReadError("patient_read_failed", queries);

  for (const q of patientQueries(patientId)) queries.push(await search(get, iss, q, resources));

  const meds = missingMedications(resources, iss);
  const medication: QueryOutcome = {
    label: "Medication",
    resourceType: "Medication",
    ok: true,
    count: 0,
    pages: 0,
    outcomes: 0,
  };
  for (const id of meds.slice(0, MAX_MEDICATION_READS)) {
    try {
      const m = (await get(`Medication/${encodeURIComponent(id)}`)) as Resource;
      medication.pages++;
      if (m?.resourceType === "Medication") {
        resources.push(m);
        medication.count++;
      }
    } catch (e) {
      medication.ok = false;
      medication.error ??= errorCode(e);
    }
  }
  if (meds.length > MAX_MEDICATION_READS) {
    medication.ok = false;
    medication.error = "page_limit";
  }
  if (meds.length) queries.push(medication);

  const bundle = assembleBundle(resources, iss);
  return { bundle, bytes: Buffer.from(JSON.stringify(bundle, null, 2) + "\n", "utf8"), queries };
}
