import { createHash } from "node:crypto";
import { fhirId, issue, type IngestIssue } from "@/canonical";
import { attr, kid, kids, text, type XNode } from "@/ingest/ccda/xml";
import { OID_SYSTEMS } from "@/mapping/systems";

/** Per-document mapping context: collects issues and keeps ids deterministic. */
export type Ctx = { issues: IngestIssue[]; docKey: string; resourceType?: string; fhirId?: string };

function warn(ctx: Ctx, code: IngestIssue["code"], message: string, path: string) {
  ctx.issues.push(
    issue("WARNING", code, message, { path, resourceType: ctx.resourceType, fhirId: ctx.fhirId }),
  );
}

export function systemUri(oid: string, ctx: Ctx, path: string): string {
  const uri = OID_SYSTEMS[oid];
  if (uri) return uri;
  warn(
    ctx,
    "unknown_code_system",
    "C-CDA codeSystem OID has no known FHIR URI; kept as urn:oid",
    path,
  );
  return `urn:oid:${oid}`;
}

type Coding = { system: string; code: string; display?: string };
type CodeableConcept = { coding?: Coding[]; text?: string };

function coding(n: XNode, ctx: Ctx, path: string): Coding | null {
  const code = attr(n, "code");
  const oid = attr(n, "codeSystem");
  if (!code || !oid) return null;
  const display = attr(n, "displayName");
  return { system: systemUri(oid, ctx, path), code, ...(display ? { display } : {}) };
}

/** CD/CE/CV -> CodeableConcept (primary code + translations). nullFlavor-only codes yield text or nothing. */
export function cd(n: XNode | undefined, ctx: Ctx, path: string): CodeableConcept | undefined {
  if (!n) return undefined;
  const codings = [n, ...kids(n, "translation")].flatMap((c) => coding(c, ctx, path) ?? []);
  const original = text(kid(n, "originalText"));
  const label = attr(n, "displayName") ?? original;
  if (!codings.length && !label) return undefined;
  return { ...(codings.length ? { coding: codings } : {}), ...(label ? { text: label } : {}) };
}

const TS = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\.\d+)?([+-]\d{4})?$/;

/**
 * HL7 v3 TS -> FHIR date/dateTime, keeping the source precision. FHIR requires a zone when a time is present;
 * C-CDA often omits it, so we assume UTC and say so (INFO, aggregated per document).
 */
export function ts(value: string | undefined, ctx: Ctx, path: string): string | undefined {
  if (!value) return undefined;
  const m = TS.exec(value);
  if (!m) {
    warn(ctx, "invalid_value", "C-CDA timestamp is not a valid TS; omitted", path);
    return undefined;
  }
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  if (!mo) return y;
  if (!d) return `${y}-${mo}`;
  if (!h) return `${y}-${mo}-${d}`;
  let zone = "Z";
  if (tz) zone = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  else
    ctx.issues.push(
      issue("INFO", "timezone_assumed_utc", "C-CDA timestamp without UTC offset; UTC assumed", {
        path,
      }),
    );
  return `${y}-${mo}-${d}T${h}:${mi ?? "00"}:${s ?? "00"}${frac ?? ""}${zone}`;
}

/** effectiveTime: either a point (value=) or an interval (low/high). */
export function timeOf(
  n: XNode | undefined,
  ctx: Ctx,
  path: string,
): { point?: string; start?: string; end?: string } {
  if (!n) return {};
  const point = ts(attr(n, "value"), ctx, path);
  if (point) return { point };
  return {
    start: ts(attr(kid(n, "low"), "value"), ctx, `${path}/low`),
    end: ts(attr(kid(n, "high"), "value"), ctx, `${path}/high`),
  };
}

/** Observation value -> FHIR value[x]. Unrendered template placeholders ("{entry.value}") are dropped with a warning. */
export function valueOf(n: XNode | undefined, ctx: Ctx, path: string): Record<string, unknown> {
  if (!n || attr(n, "nullFlavor")) return {};
  const type = attr(n, "xsi:type");
  switch (type) {
    case "PQ": {
      const v = Number(attr(n, "value"));
      if (!Number.isFinite(v)) {
        warn(ctx, "invalid_value", "PQ value is not a number; omitted", path);
        return {};
      }
      const unit = attr(n, "unit");
      return {
        valueQuantity: {
          value: v,
          ...(unit ? { unit, system: "http://unitsofmeasure.org", code: unit } : {}),
        },
      };
    }
    case "INT": {
      const v = Number(attr(n, "value"));
      if (!Number.isInteger(v)) {
        warn(ctx, "invalid_value", "INT value is not an integer; omitted", path);
        return {};
      }
      return { valueInteger: v };
    }
    case "CD":
    case "CE":
    case "CV":
    case "CO": {
      const c = cd(n, ctx, path);
      return c ? { valueCodeableConcept: c } : {};
    }
    case "ST": {
      const s = text(n);
      if (!s) return {};
      if (/^\{[\w.]+\}$/.test(s)) {
        warn(ctx, "invalid_value", "ST value is an unrendered template placeholder; omitted", path);
        return {};
      }
      return { valueString: s };
    }
    case "BL":
      return { valueBoolean: attr(n, "value") === "true" };
    default:
      warn(
        ctx,
        "invalid_value",
        `C-CDA value type ${type ?? "(none)"} is not mapped; omitted`,
        path,
      );
      return {};
  }
}

/**
 * Deterministic FHIR id for a C-CDA entry: the id root when it is already a valid FHIR id (Synthea uses UUIDs),
 * otherwise a hash of root/extension, or of the document and XPath when the entry has no id.
 */
export function entryId(n: XNode | undefined, ctx: Ctx, path: string): string {
  const idEl = kid(n, "id");
  const root = attr(idEl, "root");
  const ext = attr(idEl, "extension");
  if (root && !ext && fhirId.safeParse(root).success) return root;
  const key = root ? `${root}|${ext ?? ""}` : `${ctx.docKey}|${path}`;
  return `ccda-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}
