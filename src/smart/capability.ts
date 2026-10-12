// What a FHIR server says it supports, from its CapabilityStatement (GET {iss}/metadata). Phase 5 records the write
// interactions per resource type; nothing here sends a write.
import { z } from "zod";

export const WRITE_INTERACTIONS = ["create", "update", "patch", "delete"] as const;
export type WriteInteraction = (typeof WRITE_INTERACTIONS)[number];
const READ_INTERACTIONS = ["read", "vread", "search-type", "history-instance"] as const;

/** Types the reconcile flow can produce a write for, and the document path (C-CDA / document submission). */
export const RECONCILE_WRITE_TYPES = [
  "Condition",
  "MedicationRequest",
  "MedicationStatement",
  "AllergyIntolerance",
] as const;
export const DOCUMENT_WRITE_TYPES = ["DocumentReference", "Binary"] as const;

const capabilityShape = z.looseObject({
  resourceType: z.literal("CapabilityStatement"),
  fhirVersion: z.string().optional(),
  date: z.string().optional(),
  publisher: z.string().optional(),
  name: z.string().optional(),
  software: z
    .looseObject({ name: z.string().optional(), version: z.string().optional() })
    .optional(),
  rest: z
    .array(
      z.looseObject({
        mode: z.string().optional(),
        resource: z
          .array(
            z.looseObject({
              type: z.string(),
              interaction: z.array(z.looseObject({ code: z.string() })).default([]),
              searchParam: z.array(z.looseObject({ name: z.string() })).default([]),
              operation: z.array(z.looseObject({ name: z.string() })).default([]),
            }),
          )
          .default([]),
        operation: z.array(z.looseObject({ name: z.string() })).default([]),
      }),
    )
    .default([]),
});

export type CapabilitySummary = {
  iss: string;
  fhirVersion: string | null;
  software: string | null;
  publisher: string | null;
  date: string | null;
  resources: { type: string; interactions: string[]; searchParams: number; operations: string[] }[];
  systemOperations: string[];
};

export class CapabilityError extends Error {}

/** Server-mode rest entry only; types sorted; interactions as declared (deduplicated, sorted). */
export function summarizeCapability(json: unknown, iss: string): CapabilitySummary {
  const r = capabilityShape.safeParse(json);
  if (!r.success) throw new CapabilityError("Not a FHIR CapabilityStatement");
  const cs = r.data;
  const rest = cs.rest.find((x) => x.mode === "server") ?? cs.rest[0];
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    iss,
    fhirVersion: cs.fhirVersion ?? null,
    software: cs.software
      ? [cs.software.name, cs.software.version].filter(Boolean).join(" ") || null
      : null,
    publisher: cs.publisher ?? null,
    date: cs.date ?? null,
    resources: (rest?.resource ?? [])
      .map((x) => ({
        type: x.type,
        interactions: uniq(x.interaction.map((i) => i.code)),
        searchParams: x.searchParam.length,
        operations: uniq(x.operation.map((o) => o.name)),
      }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    systemOperations: uniq((rest?.operation ?? []).map((o) => o.name)),
  };
}

export function supports(cs: CapabilitySummary | null, type: string, interaction: string): boolean {
  return !!cs?.resources.find((r) => r.type === type)?.interactions.includes(interaction);
}

const mark = (on: boolean) => (on ? "yes" : "-");

/**
 * Markdown report of the write-back paths a server allows. `fetchedAt` and the server URL are printed so a report is
 * never mistaken for another server's (the test mock's in particular).
 */
export function renderWritebackReport(cs: CapabilitySummary, fetchedAt: Date): string {
  const writable = cs.resources.filter((r) =>
    WRITE_INTERACTIONS.some((w) => r.interactions.includes(w)),
  );
  const lines = [
    "# Write-back allowed by the FHIR server (from its CapabilityStatement)",
    "",
    `- Server (iss): ${cs.iss}`,
    `- Fetched: ${fetchedAt.toISOString()} (\`GET {iss}/metadata\`)`,
    `- Software: ${cs.software ?? "not stated"} · FHIR ${cs.fhirVersion ?? "version not stated"} · publisher ${cs.publisher ?? "not stated"} · statement date ${cs.date ?? "not stated"}`,
    `- Resource types declared: ${cs.resources.length}; with any write interaction: ${writable.length}`,
    "",
    "A declared interaction is what the server advertises, not a promise that a given app registration may use it:",
    "the app's scopes and the vendor's review decide that. MediSync sends no writes in Phase 5.",
    "",
    "## Types MediSync reconciles",
    "",
    "| Type | read | search | create | update | patch | delete |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...RECONCILE_WRITE_TYPES.map((t) => {
      const has = (i: string) => mark(supports(cs, t, i));
      return `| ${t} | ${has("read")} | ${has("search-type")} | ${has("create")} | ${has("update")} | ${has("patch")} | ${has("delete")} |`;
    }),
    "",
    "## Document submission path",
    "",
    "| Type | create | update |",
    "| --- | --- | --- |",
    ...DOCUMENT_WRITE_TYPES.map(
      (t) => `| ${t} | ${mark(supports(cs, t, "create"))} | ${mark(supports(cs, t, "update"))} |`,
    ),
    "",
    "## Write-back paths",
    "",
    "1. Provider-reviewed export package (US Core bundle, Phase 3): always available; needs no server write support.",
    `2. FHIR writes for reconciled items: ${
      RECONCILE_WRITE_TYPES.filter(
        (t) => supports(cs, t, "create") || supports(cs, t, "update"),
      ).join(", ") || "none declared"
    }.`,
    `3. Document submission (C-CDA or PDF via DocumentReference/Binary): ${
      DOCUMENT_WRITE_TYPES.filter((t) => supports(cs, t, "create")).join(", ") || "none declared"
    }.`,
    "",
    "## Every type with a write interaction",
    "",
    ...(writable.length
      ? [
          "| Type | write interactions |",
          "| --- | --- |",
          ...writable.map(
            (r) =>
              `| ${r.type} | ${r.interactions.filter((i) => (WRITE_INTERACTIONS as readonly string[]).includes(i)).join(", ")} |`,
          ),
        ]
      : ["None declared."]),
    "",
    "## Read-only types",
    "",
    cs.resources
      .filter(
        (r) => !writable.includes(r) && READ_INTERACTIONS.some((i) => r.interactions.includes(i)),
      )
      .map((r) => r.type)
      .join(", ") || "None.",
    "",
  ];
  return lines.join("\n");
}
