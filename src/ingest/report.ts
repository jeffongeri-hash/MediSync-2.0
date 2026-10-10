import type { Db } from "@/db";

const FORMATS = ["FHIR_BUNDLE", "FHIR_NDJSON", "CCDA"] as const;
type Format = (typeof FORMATS)[number];
const LABEL: Record<Format, string> = { FHIR_BUNDLE: "Bundle", FHIR_NDJSON: "NDJSON", CCDA: "C-CDA" };
const SEVERITIES = ["ERROR", "WARNING", "INFO"] as const;
type Severity = (typeof SEVERITIES)[number];

export type ReportInput = {
  patients: { id: string; sourcePatientId: string }[];
  canonical: { patientId: string; format: Format; count: number }[];
  /** `occurrences` sums aggregated INFO rows (details.count); `rows` counts mapping_issues rows. */
  issues: { patientId: string | null; filename: string | null; format: Format; severity: Severity; code: string; rows: number; occurrences: number; example: string }[];
  generatedAt: Date;
  parserVersion: string;
};

export type PatientLine = { patient: string; canonical: Record<Format, number>; issues: Record<Severity, number> };

export function patientLines(input: ReportInput): PatientLine[] {
  return input.patients
    .map((p) => {
      const canonical = Object.fromEntries(FORMATS.map((f) => [f, 0])) as Record<Format, number>;
      for (const c of input.canonical) if (c.patientId === p.id) canonical[c.format] += c.count;
      const issues = { ERROR: 0, WARNING: 0, INFO: 0 };
      for (const i of input.issues) if (i.patientId === p.id) issues[i.severity] += i.occurrences;
      // Synthea ids are random UUIDs; a short prefix is enough to find the patient and carries no PHI.
      return { patient: p.sourcePatientId.slice(0, 8), canonical, issues };
    })
    .sort((a, b) => a.patient.localeCompare(b.patient));
}

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

/** Markdown issue report: per patient, per issue code, and for sources not tied to one patient. Ids and counts only. */
export function renderIngestReport(input: ReportInput): string {
  const lines = patientLines(input);
  const total = (s: Severity) => input.issues.filter((i) => i.severity === s).reduce((n, i) => n + i.occurrences, 0);
  const out: string[] = [
    "# Ingest issue report",
    "",
    `Generated ${input.generatedAt.toISOString()} by parser ${input.parserVersion}. Synthetic data only; patients are shown by source id prefix.`,
    "",
    `- Patients: ${lines.length}; fully ingested in all three formats: ${lines.filter((l) => FORMATS.every((f) => l.canonical[f] > 0)).length}`,
    `- Canonical resources: ${FORMATS.map((f) => `${LABEL[f]} ${input.canonical.filter((c) => c.format === f).reduce((n, c) => n + c.count, 0)}`).join(", ")}`,
    `- Issue occurrences: ${SEVERITIES.map((s) => `${s} ${total(s)}`).join(", ")}`,
    "",
    "## Per patient",
    "",
    row(["Patient", ...FORMATS.map((f) => `${LABEL[f]} resources`), ...SEVERITIES]),
    row(Array(1 + FORMATS.length + SEVERITIES.length).fill("---")),
    ...lines.map((l) => row([`\`${l.patient}\``, ...FORMATS.map((f) => l.canonical[f]), ...SEVERITIES.map((s) => l.issues[s])])),
    "",
    "## By issue code",
    "",
    row(["Severity", "Code", "Format", "Rows", "Occurrences", "Example"]),
    row(Array(6).fill("---")),
  ];
  const byCode = new Map<string, ReportInput["issues"][number]>();
  for (const i of input.issues) {
    const key = `${i.severity}|${i.code}|${i.format}`;
    const g = byCode.get(key);
    if (g) {
      g.rows += i.rows;
      g.occurrences += i.occurrences;
    } else byCode.set(key, { ...i });
  }
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  for (const i of [...byCode.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code) || a.format.localeCompare(b.format))) {
    out.push(row([i.severity, `\`${i.code}\``, LABEL[i.format], i.rows, i.occurrences, i.example.replaceAll("|", "\\|")]));
  }
  const unattached = input.issues.filter((i) => !i.patientId);
  if (unattached.length) {
    out.push("", "## Sources not tied to one patient", "", row(["Source", "Format", ...SEVERITIES]), row(Array(2 + SEVERITIES.length).fill("---")));
    const bySource = new Map<string, { format: Format; counts: Record<Severity, number> }>();
    for (const i of unattached) {
      const key = i.filename ?? "(unnamed)";
      const g = bySource.get(key) ?? { format: i.format, counts: { ERROR: 0, WARNING: 0, INFO: 0 } };
      g.counts[i.severity] += i.occurrences;
      bySource.set(key, g);
    }
    for (const [name, g] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(row([`\`${name}\``, LABEL[g.format], ...SEVERITIES.map((s) => g.counts[s])]));
    }
  }
  return `${out.join("\n")}\n`;
}

/** Reads the report input for one source system from the database. */
export async function loadReportInput(db: Db, sourceSystem: string, parserVersion: string): Promise<ReportInput> {
  const patients = await db.patient.findMany({ where: { sourceSystem }, select: { id: true, sourcePatientId: true } });
  const canonical = await db.$queryRaw<{ patientId: string; format: Format; count: number }[]>`
    SELECT c.patient_id::text AS "patientId", s.format::text AS format, count(*)::int AS count
    FROM canonical_resources c JOIN source_records s ON s.id = c.source_record_id
    WHERE s.source_system = ${sourceSystem} GROUP BY 1, 2`;
  const issues = await db.$queryRaw<ReportInput["issues"]>`
    SELECT i.patient_id::text AS "patientId", CASE WHEN i.patient_id IS NULL THEN s.filename END AS filename,
           s.format::text AS format, i.severity::text AS severity, i.code,
           count(*)::int AS rows, sum(coalesce((i.details->>'count')::int, 1))::int AS occurrences, min(i.message) AS example
    FROM mapping_issues i JOIN source_records s ON s.id = i.source_record_id
    WHERE s.source_system = ${sourceSystem} GROUP BY 1, 2, 3, 4, 5`;
  return { patients, canonical, issues, generatedAt: new Date(), parserVersion };
}
