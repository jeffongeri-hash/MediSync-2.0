/** Maps a source-local reference ("urn:uuid:..." or "Type?identifier=sys|val") to a literal "Type/id". */
export type ReferenceIndex = Map<string, string>;

type Entry = { fullUrl?: string; request?: { url?: string; ifNoneExist?: string }; resource: { resourceType: string; id?: string; identifier?: unknown } };

/** Indexes a bundle's fullUrls, conditional-create keys and identifiers so other sources can resolve against it. */
export function indexBundleEntries(entries: Entry[], into: ReferenceIndex = new Map()): ReferenceIndex {
  for (const e of entries) {
    const { resourceType, id } = e.resource;
    if (!id) continue;
    const literal = `${resourceType}/${id}`;
    if (e.fullUrl) into.set(e.fullUrl, literal);
    if (e.request?.ifNoneExist) into.set(`${e.request.url ?? resourceType}?${e.request.ifNoneExist}`, literal);
    if (Array.isArray(e.resource.identifier)) {
      for (const i of e.resource.identifier as { system?: string; value?: string }[]) {
        if (i.system && i.value) into.set(`${resourceType}?identifier=${i.system}|${i.value}`, literal);
      }
    }
  }
  return into;
}

const LOCAL = /^urn:(uuid|oid):|\?/;

/**
 * Returns a deep copy with every resolvable `reference` rewritten to "Type/id". Literal and contained ("#x")
 * references are left as they are; local ones that cannot be resolved are returned as JSON paths (no values).
 */
export function rewriteReferences<T>(resource: T, index: ReferenceIndex, basePath: string): { resource: T; unresolved: string[] } {
  const unresolved: string[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "reference" && typeof v === "string" && LOCAL.test(v) && !v.startsWith("#")) {
        const hit = index.get(v);
        if (!hit) unresolved.push(`${path}.reference`);
        out[k] = hit ?? v;
      } else {
        out[k] = walk(v, `${path}.${k}`);
      }
    }
    return out;
  };
  return { resource: walk(resource, basePath) as T, unresolved };
}

/** "Patient/abc" -> "abc"; anything else -> null. */
export function patientIdOf(ref: unknown): string | null {
  const r = (ref as { reference?: unknown } | undefined)?.reference;
  return typeof r === "string" && r.startsWith("Patient/") ? r.slice("Patient/".length) : null;
}
