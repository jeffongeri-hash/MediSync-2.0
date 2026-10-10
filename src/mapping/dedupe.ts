// Cross-format dedupe for one patient. Links, never merges: every row stays, and duplicates point at one primary
// row, so reconciliation can still show each source's version of a fact.
import { issue, type IngestIssue } from "@/canonical";

export type SourceFormat = "FHIR_BUNDLE" | "FHIR_NDJSON" | "CCDA";

export type DedupeRow = {
  id: string;
  resourceType: string;
  fhirId: string;
  sourceRecordId: string;
  sourceSystem: string;
  format: SourceFormat;
  codeSystem: string | null;
  code: string | null;
  /** ISO instant, see clinicalDate(). */
  sourceDate: string | null;
};

export type DedupeLink = {
  id: string;
  dedupeKey: string;
  duplicateOfId: string | null;
  matchedBy: "id" | "content" | null;
};

/** Primary-row preference when several sources carry the same fact: structured FHIR first, C-CDA last. */
export const FORMAT_RANK: Record<SourceFormat, number> = { FHIR_BUNDLE: 0, FHIR_NDJSON: 1, CCDA: 2 };

/** C-CDA has no MedicationRequest; its medications arrive as MedicationStatement under the same ids. */
const family = (t: string) => (t === "MedicationRequest" || t === "MedicationStatement" ? "MedicationUse" : t);

const byPreference = (a: DedupeRow, b: DedupeRow) =>
  FORMAT_RANK[a.format] - FORMAT_RANK[b.format] || a.sourceRecordId.localeCompare(b.sourceRecordId) || a.id.localeCompare(b.id);

/**
 * 1. Same resource id from the same source system (any format) = the same fact. Ids are only trusted within one
 *    source system; two systems can reuse an id for unrelated things.
 * 2. Rows still alone are matched on family + primary code + clinical day, but only when each source contributes
 *    exactly one row to that key (two readings on one day in one source are two facts, and an ambiguous match is
 *    left for a human).
 * Linked rows whose primary codes disagree raise `duplicate_conflict` for review.
 */
export function dedupePatient(rows: DedupeRow[]): { links: DedupeLink[]; issues: (IngestIssue & { rowId: string })[] } {
  const issues: (IngestIssue & { rowId: string })[] = [];
  const links = new Map<string, DedupeLink>();
  const idKey = (r: DedupeRow) => `id:${family(r.resourceType)}/${r.sourceSystem}/${r.fhirId}`;

  const link = (cluster: DedupeRow[], key: string, matchedBy: "id" | "content") => {
    const [primary, ...rest] = [...cluster].sort(byPreference);
    links.set(primary!.id, { id: primary!.id, dedupeKey: key, duplicateOfId: null, matchedBy });
    for (const r of rest) {
      links.set(r.id, { id: r.id, dedupeKey: key, duplicateOfId: primary!.id, matchedBy });
      if (primary!.code && r.code && (primary!.codeSystem !== r.codeSystem || primary!.code !== r.code)) {
        issues.push({
          rowId: r.id,
          ...issue("WARNING", "duplicate_conflict", `${r.resourceType} duplicate (matched by ${matchedBy}) has a different primary code than its primary row`, {
            resourceType: r.resourceType,
            fhirId: r.fhirId,
            details: { primaryCode: `${primary!.codeSystem}|${primary!.code}`, code: `${r.codeSystem}|${r.code}`, primaryFormat: primary!.format },
          }),
        });
      }
    }
  };

  const groups = new Map<string, DedupeRow[]>();
  for (const r of rows) groups.set(idKey(r), [...(groups.get(idKey(r)) ?? []), r]);
  const alone: DedupeRow[] = [];
  for (const [key, g] of groups) {
    if (g.length > 1) link(g, key, "id");
    else alone.push(g[0]!);
  }

  const byContent = new Map<string, DedupeRow[]>();
  for (const r of alone) {
    if (!r.code || !r.sourceDate) continue;
    const key = `code:${family(r.resourceType)}/${r.codeSystem}|${r.code}/${r.sourceDate.slice(0, 10)}`;
    byContent.set(key, [...(byContent.get(key) ?? []), r]);
  }
  for (const [key, g] of byContent) {
    const sources = new Set(g.map((r) => r.sourceRecordId));
    if (g.length > 1 && sources.size === g.length) link(g, key, "content");
  }

  for (const r of rows) if (!links.has(r.id)) links.set(r.id, { id: r.id, dedupeKey: idKey(r), duplicateOfId: null, matchedBy: null });
  return { links: rows.map((r) => links.get(r.id)!), issues };
}
