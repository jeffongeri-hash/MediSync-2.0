import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getDemoData } from "@/demo/data";
import { PHASE1_COLUMNS, ageOn, formatBytes, phase1Counts, shortHash } from "@/demo/format";
import { demoMode } from "@/security/roles";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MediSync Intake Demo" };

const FORMAT_LABEL = { FHIR_BUNDLE: "FHIR R4 bundle", FHIR_NDJSON: "FHIR NDJSON", CCDA: "C-CDA R2.1" } as const;
const FORMAT_CLASS = { FHIR_BUNDLE: "pill pill-fhir", FHIR_NDJSON: "pill pill-fhir", CCDA: "pill pill-ccda" } as const;

const dateTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export default async function DemoPage() {
  if (!demoMode()) notFound();
  const data = await getDemoData(getDb(), "demo:viewer");
  const now = new Date();
  const { counts } = data;

  const stats = [
    { label: "Patients", value: counts.patientCount, note: "patients · indexed by source id", state: "done" },
    { label: "Source records", value: counts.sourceRecordCount, note: "source_records · raw, untouched", state: "done" },
    { label: "Canonical resources", value: counts.canonicalCount, note: "canonical_resources · Phase 1", state: "next" },
    { label: "Open mapping issues", value: counts.openIssueCount, note: "mapping_issues · Phase 1–2", state: "next" },
    { label: "Audit entries", value: counts.auditCount, note: "audit_log · append-only", state: "done" },
  ];

  return (
    <main className="page">
      <header className="masthead">
        <div className="masthead-row">
          <p className="eyebrow">MediSync · Phase 0 intake</p>
          <span className="pill pill-synthetic">Synthetic data · Synthea</span>
        </div>
        <h1>Intake demo</h1>
        <p className="lede">
          Ten synthetic patients from Synthea, each received twice: once as a FHIR R4 transaction bundle and once
          as a C-CDA document. Every file is stored byte-for-byte with its SHA-256, and every read and write on
          this page lands in the audit log.
        </p>
        <p className="fine">Rendered {dateTime(now)} from the MediSync database.</p>
      </header>

      <section aria-labelledby="tables-h">
        <h2 id="tables-h">Pipeline tables</h2>
        <ol className="stats">
          {stats.map((s) => (
            <li key={s.label} className={`stat stat-${s.state}`}>
              <span className="stat-value">{s.value.toLocaleString("en-US")}</span>
              <span className="stat-label">{s.label}</span>
              <span className="stat-note">{s.note}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="patients-h">
        <h2 id="patients-h">Patients and what their FHIR bundles hold</h2>
        <p className="section-lede">
          Counts of the resource types Phase 1 has to ingest, read from each bundle at intake. Synthea also emits
          billing resources (Claim, ExplanationOfBenefit), which are counted in the entry total.
        </p>
        <div className="table-scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Patient</th>
                {PHASE1_COLUMNS.map((c) => (
                  <th key={c.key} scope="col" className="num" title={c.types.join(" + ")}>
                    {c.label}
                  </th>
                ))}
                <th scope="col" className="num">Entries</th>
                <th scope="col" className="num">C-CDA sections</th>
              </tr>
            </thead>
            <tbody>
              {data.patients.map((p) => {
                const pc = phase1Counts(p.fhirSummary?.resourceCounts ?? {});
                return (
                  <tr key={p.id}>
                    <th scope="row">
                      <span className="name">{p.displayName ?? "Unnamed"}</span>
                      <span className="subtle">
                        {[p.gender, p.birthDate ? `${ageOn(p.birthDate, now)} y` : null].filter(Boolean).join(" · ")}
                        {" · "}
                        <span className="mono">{p.sourcePatientId.slice(0, 8)}</span>
                      </span>
                    </th>
                    {PHASE1_COLUMNS.map((c) => (
                      <td key={c.key} className={pc[c.key] ? "num" : "num zero"}>
                        {pc[c.key]}
                      </td>
                    ))}
                    <td className="num strong">{p.fhirSummary?.entryCount ?? "—"}</td>
                    <td className="num">{p.ccdaSummary?.sectionCount ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="sources-h">
        <h2 id="sources-h">Source records</h2>
        <p className="section-lede">
          The raw files as received. The preview is the first 900 characters of the stored text; the hash is
          computed over the original bytes.
        </p>
        <div className="sources">
          {data.patients.map((p, i) => (
            <details key={p.id} className="source" open={i === 0}>
              <summary>
                <span className="name">{p.displayName ?? "Unnamed"}</span>
                <span className="subtle">
                  {p.sourceRecords.length} files ·{" "}
                  {formatBytes(p.sourceRecords.reduce((n, r) => n + r.byteSize, 0))}
                </span>
              </summary>
              <div className="files">
                {p.sourceRecords.map((r) => (
                  <article key={r.id} className="file">
                    <div className="file-meta">
                      <span className={FORMAT_CLASS[r.format]}>{FORMAT_LABEL[r.format]}</span>
                      <span className="mono filename">{r.filename}</span>
                    </div>
                    <dl className="facts">
                      <div>
                        <dt>Size</dt>
                        <dd className="mono">{formatBytes(r.byteSize)}</dd>
                      </div>
                      <div>
                        <dt>SHA-256</dt>
                        <dd className="mono" title={r.sha256}>
                          {shortHash(r.sha256)}
                        </dd>
                      </div>
                      <div>
                        <dt>Received</dt>
                        <dd className="mono">{dateTime(r.receivedAt)}</dd>
                      </div>
                    </dl>
                    <pre className="raw" tabIndex={0} aria-label={`Start of ${r.filename}`}>
                      {r.preview}
                      {"\n…"}
                    </pre>
                  </article>
                ))}
              </div>
            </details>
          ))}
        </div>
        {data.references.length > 0 && (
          <p className="fine">
            Also stored, with no patient attached: {data.references.map((r) => `${r.filename} (${formatBytes(r.byteSize)})`).join(", ")}.
            These hold the Organization and Practitioner resources the patient bundles reference.
          </p>
        )}
      </section>

      <section aria-labelledby="audit-h">
        <h2 id="audit-h">Audit log, latest 12</h2>
        <p className="section-lede">
          Opening this page wrote one READ per patient. The table refuses UPDATE and DELETE at the database level.
        </p>
        <div className="table-scroll">
          <table className="ledger audit">
            <thead>
              <tr>
                <th scope="col" className="num">#</th>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Entity</th>
                <th scope="col">Patient</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAudit.map((a) => (
                <tr key={a.id.toString()}>
                  <td className="num subtle">{a.id.toString()}</td>
                  <td className="mono">{dateTime(a.occurredAt)}</td>
                  <td className="mono">{a.actor}</td>
                  <td>
                    <span className={`pill pill-action pill-${a.action.toLowerCase()}`}>{a.action}</span>
                  </td>
                  <td>{a.entityType}</td>
                  <td className="mono subtle">{a.patientId ? a.patientId.slice(0, 8) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="foot">
        <p>
          Next: Phase 1 parses these sources into Zod-validated FHIR R4 resources in canonical_resources, and
          anything that does not parse cleanly goes to mapping_issues.
        </p>
      </footer>
    </main>
  );
}
