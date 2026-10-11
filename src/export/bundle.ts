// Transaction Bundle assembly: deterministic urn:uuid fullUrls, reference rewriting, structural validation.
// Entries are POSTs, so the target assigns ids; source identity travels in each resource's Provenance.
import { createHash } from "node:crypto";
import { z } from "zod";
import { fhirDateTime } from "@/canonical";

type Json = Record<string, unknown>;

/** A stable UUID (RFC 9562 version 8 layout) derived from a key such as "Condition/abc". */
export function entryUuid(key: string): string {
  const h = createHash("sha256").update(`medisync:${key}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const fullUrlFor = (key: string) => `urn:uuid:${entryUuid(key)}`;

export type DroppedReference = {
  /** Path of the Reference element, e.g. "participant[0].individual". */
  path: string;
  targetType: string;
  /** outside_scope: the type is not in the canonical model; not_exported: the target is not in this bundle. */
  reason: "outside_scope" | "not_exported";
};

const LITERAL = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/;

/**
 * Rewrites every literal reference whose target is in the bundle to that entry's urn:uuid. Any other reference
 * loses `reference` and keeps its display; a Reference left empty gets a display saying the target was not sent.
 * Contained ("#x") references are left alone. Mutates `resource`.
 */
export function rewriteReferences(
  resource: Json,
  fullUrls: ReadonlyMap<string, string>,
  inScope: (type: string) => boolean,
): DroppedReference[] {
  const dropped: DroppedReference[] = [];
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (typeof node !== "object" || node === null) return;
    const o = node as Json;
    if (typeof o.reference === "string" && !o.reference.startsWith("#")) {
      const target = fullUrls.get(o.reference);
      if (target) {
        o.reference = target;
      } else {
        const targetType = LITERAL.exec(o.reference)?.[1] ?? "unknown";
        dropped.push({
          path,
          targetType,
          reason: inScope(targetType) ? "not_exported" : "outside_scope",
        });
        delete o.reference;
        if (!o.display && !o.identifier)
          o.display = `${targetType} record not included in this transfer`;
      }
    }
    for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(resource, "");
  return dropped;
}

const urnUuid = z
  .string()
  .regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const entrySchema = z
  .strictObject({
    fullUrl: urnUuid,
    resource: z
      .looseObject({ resourceType: z.string() })
      .refine((r) => !("id" in r), "POST entries carry no id"),
    request: z.strictObject({ method: z.literal("POST"), url: z.string() }),
  })
  .refine(
    (e) => e.request.url === e.resource.resourceType,
    "request.url must be the resource type",
  );

function references(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((v) => references(v, out));
  else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "reference" && typeof v === "string") out.push(v);
      else references(v, out);
    }
  }
  return out;
}

/** A transaction Bundle of POST entries whose references all resolve inside the bundle. */
export const transactionBundleSchema = z
  .strictObject({
    resourceType: z.literal("Bundle"),
    type: z.literal("transaction"),
    timestamp: fhirDateTime,
    entry: z.array(entrySchema).min(1),
  })
  .superRefine((b, ctx) => {
    const urls = new Set(b.entry.map((e) => e.fullUrl));
    if (urls.size !== b.entry.length)
      ctx.addIssue({ code: "custom", message: "duplicate fullUrl" });
    const bad = references(b.entry).filter((r) => !r.startsWith("#") && !urls.has(r));
    if (bad.length)
      ctx.addIssue({
        code: "custom",
        message: `${bad.length} reference(s) do not resolve in the bundle`,
      });
  });
export type TransactionBundle = z.infer<typeof transactionBundleSchema>;

export type BundleEntry = { fullUrl: string; resource: Json };

export function assembleBundle(entries: BundleEntry[], timestamp: string): TransactionBundle {
  return transactionBundleSchema.parse({
    resourceType: "Bundle",
    type: "transaction",
    timestamp,
    entry: entries.map((e) => ({
      fullUrl: e.fullUrl,
      resource: e.resource,
      request: { method: "POST", url: e.resource.resourceType },
    })),
  });
}

/** Exact bytes written and hashed. */
export const serializeBundle = (b: TransactionBundle) => `${JSON.stringify(b, null, 2)}\n`;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
