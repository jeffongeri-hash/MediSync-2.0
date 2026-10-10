/** Findings raised while turning a source into canonical FHIR. Messages carry types and paths, never PHI. */
export type IssueSeverity = "INFO" | "WARNING" | "ERROR";

export const ISSUE_CODES = [
  "parse_error", // source bytes could not be parsed at all (bad JSON line, malformed XML)
  "schema_invalid", // resource failed canonical Zod validation; raw source is kept, no canonical row
  "unsupported_resource", // valid FHIR, but outside the Phase 1 resource scope
  "unresolved_reference", // a reference could not be rewritten to Type/id
  "missing_code", // primary code absent or text-only (goes to review, never dropped)
  "unknown_code_system", // C-CDA codeSystem OID with no known FHIR URI
  "unmapped_section", // C-CDA section or entry template we do not convert
  "unknown_patient", // resource whose patient is not in the patient index
  "defaulted_field", // a required FHIR field was filled with an explicit unknown/derived value
  "timezone_assumed_utc", // C-CDA timestamp had no offset
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export type IssueDetails = Record<string, string | number | boolean | null>;

export type IngestIssue = {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  /** Location in the raw source, e.g. "Bundle.entry[12].resource.subject" or an XPath. */
  path?: string;
  resourceType?: string;
  fhirId?: string;
  details?: IssueDetails;
};

export function issue(
  severity: IssueSeverity,
  code: IssueCode,
  message: string,
  extra: Omit<IngestIssue, "severity" | "code" | "message"> = {},
): IngestIssue {
  return { severity, code, message, ...extra };
}

/**
 * Collapses INFO issues sharing (code, resourceType, message) into one row with a count, so a source with
 * hundreds of out-of-scope Claims yields one finding. WARNING and ERROR stay per-item for the review queue.
 */
export function aggregateInfo(issues: IngestIssue[]): IngestIssue[] {
  const out: IngestIssue[] = [];
  const groups = new Map<string, IngestIssue & { details: IssueDetails }>();
  for (const i of issues) {
    if (i.severity !== "INFO") {
      out.push(i);
      continue;
    }
    const key = `${i.code}\u0000${i.resourceType ?? ""}\u0000${i.message}`;
    const g = groups.get(key);
    if (g) {
      g.details.count = Number(g.details.count) + 1;
    } else {
      const agg = { ...i, fhirId: undefined, details: { ...i.details, count: 1, firstPath: i.path ?? null } };
      groups.set(key, agg);
      out.push(agg);
    }
  }
  return out;
}
