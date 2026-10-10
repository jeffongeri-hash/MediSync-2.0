// Canonical model: FHIR R4 resources validated with Zod. Every source maps INTO it.
import {
  canonicalSchemas,
  isCanonicalType,
  PRIMARY_CODE,
  type CanonicalResource,
} from "@/canonical/fhir";
import { issue, type IngestIssue } from "@/canonical/issues";

export * from "@/canonical/fhir";
export * from "@/canonical/issues";

export type CanonicalResult = { resource: CanonicalResource | null; issues: IngestIssue[] };

/**
 * Validates one source resource against the canonical schema. Never throws: out-of-scope types become INFO,
 * invalid ones ERROR (raw stays in source_records), and a missing primary code a WARNING for review.
 */
export function toCanonical(raw: unknown, path: string): CanonicalResult {
  const rt =
    typeof raw === "object" && raw !== null
      ? (raw as { resourceType?: unknown }).resourceType
      : undefined;
  if (typeof rt !== "string") {
    return {
      resource: null,
      issues: [issue("ERROR", "schema_invalid", "Not a FHIR resource (no resourceType)", { path })],
    };
  }
  if (!isCanonicalType(rt)) {
    return {
      resource: null,
      issues: [
        issue(
          "INFO",
          "unsupported_resource",
          `${rt} is outside the canonical scope; kept raw only`,
          { path, resourceType: rt },
        ),
      ],
    };
  }

  const id = (raw as { id?: unknown }).id;
  const fhirId = typeof id === "string" ? id : undefined;
  const parsed = canonicalSchemas[rt].safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      resource: null,
      issues: [
        issue("ERROR", "schema_invalid", `${rt} failed validation: ${where}`, {
          path,
          resourceType: rt,
          fhirId,
        }),
      ],
    };
  }

  const resource = parsed.data as CanonicalResource;
  const issues: IngestIssue[] = [];
  const codeField = PRIMARY_CODE[rt];
  if (codeField && !(rt.startsWith("Medication") && "medicationReference" in resource)) {
    const cc = (resource as Record<string, unknown>)[codeField] as
      { coding?: { system?: string; code?: string }[] } | undefined;
    if (!cc?.coding?.some((c) => c.system && c.code)) {
      issues.push(
        issue("WARNING", "missing_code", `${rt}.${codeField} has no coded value (system + code)`, {
          path: `${path}.${codeField}`,
          resourceType: rt,
          fhirId: resource.id,
        }),
      );
    }
  }
  return { resource, issues };
}
