// Phase 2 gate: mapping coverage report (Markdown) for one source system. Rendering is pure; loading is SQL.
import type { Db } from "@/db";
import { systemName } from "@/mapping/map-resource";
import { SYSTEM } from "@/mapping/systems";

const FORMATS = ["FHIR_BUNDLE", "FHIR_NDJSON", "CCDA"] as const;
type Format = (typeof FORMATS)[number];
const LABEL: Record<Format, string> = { FHIR_BUNDLE: "Bundle", FHIR_NDJSON: "NDJSON", CCDA: "C-CDA" };
type Status = "MAPPED" | "UNMAPPED" | "NO_CODE" | "NOT_APPLICABLE";

export type MappingReportInput = {
  /** Rows per (type, format, primary system, primary code, status). */
  codes: { resourceType: string; format: Format; codeSystem: string | null; code: string | null; status: Status; rows: number }[];
  /** MAPPING and DEDUPE issues per (stage, severity, code, format, status, coded subject). */
  queue: {
    stage: string;
    severity: string;
    code: string;
    format: Format;
    status: string;
    resourceType: string | null;
    target: string | null;
    codeSystem: string | null;
    codeValue: string | null;
    display: string | null;
    example: string;
    rows: number;
  }[];
  icd: { format: Format; snomedConditions: number; withIcd: number; derived: number }[];
  units: { format: Format; quantities: number; ucum: number }[];
  dedupe: { format: Format; rows: number; primaries: number; byId: number; byContent: number }[];
  /** Gate invariant: findings that should be in the review queue but are not. Both must be 0. */
  notQueued: { unmappedRows: number; conditionsWithoutIcd: number };
  generatedAt: Date;
  mappingVersion: string;
};

const row = (cells: (string | number)[]) => `| ${cells.map((c) => String(c).replaceAll("|", "\\|")).join(" | ")} |`;
const head = (cells: string[]) => [row(cells), row(cells.map(() => "---"))];
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const sysLabel = (s: string | null) => (s ? systemName(s) : "(none)");

type Tally = { rows: number; mapped: number; unmapped: number; noCode: number; codes: Set<string> };
function tally(rows: MappingReportInput["codes"]): Tally {
  const t: Tally = { rows: 0, mapped: 0, unmapped: 0, noCode: 0, codes: new Set() };
  for (const r of rows) {
    t.rows += r.rows;
    if (r.status === "MAPPED") t.mapped += r.rows;
    if (r.status === "UNMAPPED") t.unmapped += r.rows;
    if (r.status === "NO_CODE") t.noCode += r.rows;
    if (r.code) t.codes.add(`${r.codeSystem}|${r.code}`);
  }
  return t;
}
const coded = (t: Tally) => t.mapped + t.unmapped + t.noCode;

export function renderMappingReport(input: MappingReportInput): string {
  const codes = input.codes.filter((c) => c.status !== "NOT_APPLICABLE");
  const all = tally(codes);
  const types = [...new Set(codes.map((c) => c.resourceType))].sort();
  const systems = [...new Set(codes.map((c) => c.codeSystem))].sort((a, b) => sysLabel(a).localeCompare(sysLabel(b)));
  const open = input.queue.filter((q) => q.status === "OPEN");
  const unmappedCodes = input.queue.filter((q) => q.stage === "MAPPING" && q.code === "unmapped_code");
  const gateOk = input.notQueued.unmappedRows === 0 && input.notQueued.conditionsWithoutIcd === 0;
  const distinct = (qs: MappingReportInput["queue"]) => new Set(qs.map((q) => q.codeValue)).size;
  const concepts = {
    all: new Set(
      codes.filter((c) => c.resourceType === "Condition" && c.codeSystem === SYSTEM.SNOMED && c.status === "MAPPED").map((c) => c.code),
    ).size,
    none: distinct(input.queue.filter((q) => q.code === "no_target_code")),
    missing: distinct(unmappedCodes.filter((q) => q.target === "ICD-10-CM")),
  };
  const icd = {
    snomed: sum(input.icd, (r) => r.snomedConditions),
    withIcd: sum(input.icd, (r) => r.withIcd),
    derived: sum(input.icd, (r) => r.derived),
    noTarget: sum(input.queue.filter((q) => q.code === "no_target_code"), (q) => q.rows),
    missing: sum(unmappedCodes.filter((q) => q.target === "ICD-10-CM"), (q) => q.rows),
  };

  const out = [
    "# Mapping coverage report",
    "",
    `Generated ${input.generatedAt.toISOString()} by mapping ${input.mappingVersion}. Synthetic data only.`,
    "",
    `- Coded resources: ${coded(all)}; primary code mapped: ${all.mapped} (${pct(all.mapped, coded(all))}); unmapped: ${all.unmapped}; no code: ${all.noCode}`,
    `- Distinct primary codes: ${all.codes.size}`,
    `- SNOMED CT Conditions with an ICD-10-CM code: ${icd.withIcd} of ${icd.snomed} rows (${pct(icd.withIcd, icd.snomed)}); no ICD-10-CM code applies: ${icd.noTarget}; not in the crosswalk: ${icd.missing}`,
    `- Distinct mapped SNOMED CT Condition concepts: ${concepts.all}; ${concepts.all - concepts.none - concepts.missing} with an ICD-10-CM code, ${concepts.none} where none applies, ${concepts.missing} not in the crosswalk`,
    `- Review queue (mapping and dedupe, OPEN): ${sum(open, (q) => q.rows)} issues`,
    `- Gate: unmapped findings missing from the review queue: ${input.notQueued.unmappedRows + input.notQueued.conditionsWithoutIcd} ${gateOk ? "(pass)" : "(FAIL)"}`,
    "",
    "Terminology tables are local and unverified against official releases (NLM hosts are blocked). The code tables were",
    "curated from the fixtures' own codes, so primary-code coverage of these fixtures is complete by construction; the",
    "informative numbers are the ICD-10-CM crosswalk, units, medicationReference resolution and dedupe. New sources with",
    "codes outside the tables land in the review queue below.",
    "",
    "## Coverage by resource type",
    "",
    ...head(["Resource type", "Rows", "Mapped", "Unmapped", "No code", "% mapped", "Distinct codes", ...FORMATS.map((f) => `% ${LABEL[f]}`)]),
    ...types.map((t) => {
      const ofType = codes.filter((c) => c.resourceType === t);
      const x = tally(ofType);
      const perFormat = FORMATS.map((f) => {
        const y = tally(ofType.filter((c) => c.format === f));
        return y.rows ? pct(y.mapped, coded(y)) : "–";
      });
      return row([t, x.rows, x.mapped, x.unmapped, x.noCode, pct(x.mapped, coded(x)), x.codes.size, ...perFormat]);
    }),
    "",
    "## Coverage by code system (primary code)",
    "",
    ...head(["Code system", "Resource types", "Rows", "Mapped", "% mapped", "Distinct codes"]),
    ...systems.map((s) => {
      const ofSys = codes.filter((c) => c.codeSystem === s);
      const x = tally(ofSys);
      return row([sysLabel(s), [...new Set(ofSys.map((c) => c.resourceType))].sort().join(", "), x.rows, x.mapped, pct(x.mapped, coded(x)), x.codes.size]);
    }),
    "",
    "## Derived codes and units by format",
    "",
    ...head(["Format", "SNOMED CT Conditions", "With ICD-10-CM", "Derived by crosswalk", "Observation quantities", "UCUM", "% UCUM"]),
    ...FORMATS.map((f) => {
      const i = input.icd.find((r) => r.format === f);
      const u = input.units.find((r) => r.format === f);
      return row([LABEL[f], i?.snomedConditions ?? 0, i?.withIcd ?? 0, i?.derived ?? 0, u?.quantities ?? 0, u?.ucum ?? 0, pct(u?.ucum ?? 0, u?.quantities ?? 0)]);
    }),
    "",
    "## Dedupe (cross-format links; rows are linked, never merged)",
    "",
    ...head(["Format", "Rows", "Primary", "Linked by id", "Linked by code + day"]),
    ...input.dedupe.map((d) => row([LABEL[d.format], d.rows, d.primaries, d.byId, d.byContent])),
    row(["All", sum(input.dedupe, (d) => d.rows), sum(input.dedupe, (d) => d.primaries), sum(input.dedupe, (d) => d.byId), sum(input.dedupe, (d) => d.byContent)]),
    "",
    "## Review queue (mapping and dedupe stages)",
    "",
    ...head(["Stage", "Severity", "Code", "Rows", "Open", "Distinct codes", "Example"]),
    ...[...new Set(input.queue.map((q) => `${q.stage}\u0000${q.severity}\u0000${q.code}`))].sort().map((k) => {
      const [stage, severity, code] = k.split("\u0000") as [string, string, string];
      const g = input.queue.filter((q) => q.stage === stage && q.severity === severity && q.code === code);
      const distinct = new Set(g.filter((q) => q.codeValue).map((q) => `${q.codeSystem}|${q.codeValue}`)).size;
      return row([stage, severity, `\`${code}\``, sum(g, (q) => q.rows), sum(g.filter((q) => q.status === "OPEN"), (q) => q.rows), distinct || "–", g[0]!.example]);
    }),
    "",
    "## Unmapped codes (every one is in the review queue)",
    "",
    ...(unmappedCodes.length ? codeList(unmappedCodes, true) : ["None."]),
    "",
    "## Concepts with no ICD-10-CM code (INFO, in the review queue)",
    "",
    ...codeList(input.queue.filter((q) => q.code === "no_target_code"), false),
    "",
  ];
  return out.join("\n");
}

function codeList(items: MappingReportInput["queue"], withReason: boolean): string[] {
  const groups = new Map<string, MappingReportInput["queue"]>();
  for (const q of items) {
    const k = `${q.codeSystem}|${q.codeValue}|${q.target ?? ""}|${q.resourceType}`;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  const lines = [...groups.values()]
    .sort((a, b) => `${a[0]!.resourceType}${a[0]!.display}`.localeCompare(`${b[0]!.resourceType}${b[0]!.display}`))
    .map((g) => {
      const q = g[0]!;
      const formats = FORMATS.filter((f) => g.some((x) => x.format === f)).map((f) => LABEL[f]).join(", ");
      const base = [q.resourceType ?? "", sysLabel(q.codeSystem), `\`${q.codeValue ?? ""}\``, q.display ?? "", formats, sum(g, (x) => x.rows)];
      return row(withReason ? [...base, q.target ? `not in ${q.target} crosswalk` : q.example] : base);
    });
  const cols = ["Resource type", "System", "Code", "Display", "Formats", "Rows"];
  return [...head(withReason ? [...cols, "Reason"] : cols), ...lines];
}

export async function loadMappingReportInput(db: Db, sourceSystem: string, mappingVersion: string): Promise<MappingReportInput> {
  const codes = await db.$queryRaw<MappingReportInput["codes"]>`
    select c.resource_type as "resourceType", s.format::text as format, c.code_system as "codeSystem", c.code,
      c.mapping_status::text as status, count(*)::int as rows
    from canonical_resources c join source_records s on s.id = c.source_record_id
    where s.source_system = ${sourceSystem}
    group by 1, 2, 3, 4, 5`;
  const queue = await db.$queryRaw<MappingReportInput["queue"]>`
    select i.stage::text as stage, i.severity::text as severity, i.code, s.format::text as format, i.status::text as status,
      c.resource_type as "resourceType", i.details->>'target' as target, i.details->>'system' as "codeSystem",
      i.details->>'code' as "codeValue",
      min((select x->>'display' from jsonb_array_elements(coalesce(c.mapped->'code', c.mapped->'medicationCodeableConcept',
        c.mapped->'vaccineCode', c.mapped->'type'->0, c.mapped->'type')->'coding') x where x->>'code' = i.details->>'code' limit 1)) as display,
      min(i.message) as example, count(*)::int as rows
    from mapping_issues i join source_records s on s.id = i.source_record_id
      left join canonical_resources c on c.id = i.canonical_resource_id
    where s.source_system = ${sourceSystem} and i.stage <> 'INGEST'
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9`;
  const icd = await db.$queryRaw<MappingReportInput["icd"]>`
    select s.format::text as format, count(*)::int as "snomedConditions",
      count(*) filter (where exists (select 1 from jsonb_array_elements(c.mapped->'code'->'coding') x where x->>'system' = ${SYSTEM.ICD10CM}))::int as "withIcd",
      count(*) filter (where exists (select 1 from jsonb_array_elements(c.mapped->'code'->'coding') x where x->>'system' = ${SYSTEM.ICD10CM} and x ? 'extension'))::int as derived
    from canonical_resources c join source_records s on s.id = c.source_record_id
    where s.source_system = ${sourceSystem} and c.resource_type = 'Condition' and c.code_system = ${SYSTEM.SNOMED}
    group by 1`;
  const units = await db.$queryRaw<MappingReportInput["units"]>`
    select s.format::text as format, count(*)::int as quantities, count(*) filter (where q->>'system' = ${SYSTEM.UCUM})::int as ucum
    from canonical_resources c join source_records s on s.id = c.source_record_id
      cross join lateral (select c.mapped->'valueQuantity' as q
        union all select x->'valueQuantity' from jsonb_array_elements(coalesce(c.mapped->'component', '[]'::jsonb)) x) z
    where s.source_system = ${sourceSystem} and c.resource_type = 'Observation' and q is not null
    group by 1`;
  const dedupe = await db.$queryRaw<MappingReportInput["dedupe"]>`
    select s.format::text as format, count(*)::int as rows, count(*) filter (where c.duplicate_of_id is null)::int as primaries,
      count(*) filter (where c.duplicate_of_id is not null and c.dedupe_key like 'id:%')::int as "byId",
      count(*) filter (where c.duplicate_of_id is not null and c.dedupe_key like 'code:%')::int as "byContent"
    from canonical_resources c join source_records s on s.id = c.source_record_id
    where s.source_system = ${sourceSystem}
    group by 1 order by array_position(array['FHIR_BUNDLE', 'FHIR_NDJSON', 'CCDA'], s.format::text)`;
  const [notQueued] = await db.$queryRaw<MappingReportInput["notQueued"][]>`
    select
      count(*) filter (where c.mapping_status = 'UNMAPPED' and not exists (select 1 from mapping_issues i
        where i.canonical_resource_id = c.id and i.stage = 'MAPPING' and i.code = 'unmapped_code'))::int as "unmappedRows",
      count(*) filter (where c.resource_type = 'Condition' and c.code_system = ${SYSTEM.SNOMED}
        and not exists (select 1 from jsonb_array_elements(c.mapped->'code'->'coding') x where x->>'system' = ${SYSTEM.ICD10CM})
        and not exists (select 1 from mapping_issues i where i.canonical_resource_id = c.id and i.stage = 'MAPPING'
          and i.code in ('unmapped_code', 'no_target_code')))::int as "conditionsWithoutIcd"
    from canonical_resources c join source_records s on s.id = c.source_record_id
    where s.source_system = ${sourceSystem}`;
  return { codes, queue, icd, units, dedupe, notQueued: notQueued!, generatedAt: new Date(), mappingVersion };
}
