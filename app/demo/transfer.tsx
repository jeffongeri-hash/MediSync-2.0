// The transfer section of /demo (Phase 7): pick a patient, run a dry run, read what would be kept, changed or lost,
// then approve it and send the US Core bundle to a receiving EHR. The receiving EHRs are loopback test servers named
// in TRANSFER_TARGETS; no real EHR is ever sent to.
import { z } from "zod";
import type { Db } from "@/db";
import { transferTargets, TransferTargetError, type Delivery } from "@/export/deliver";
import { approveAndSend, startDryRun } from "./actions";

type TypeRow = {
  type: string;
  selected: number;
  exported: number;
  kept: number;
  changed: number;
  lost: number;
  completeness: number;
};
const JOB = {
  id: true,
  patientId: true,
  status: true,
  dryRun: true,
  targetProfile: true,
  completeness: true,
  resourcesSelected: true,
  resourcesExported: true,
  resourcesExcluded: true,
  bundleSha256: true,
  summary: true,
  report: true,
  error: true,
  target: true,
  deliveredAt: true,
  delivery: true,
  approvedJobId: true,
  patient: { select: { displayName: true, sourceSystem: true } },
} as const;

const pct = (n: number | null) => (n === null ? "–" : `${(n * 100).toFixed(1)}%`);
const uuid = (v: string | undefined) => (z.uuid().safeParse(v).success ? v! : null);

export async function TransferSection({
  db,
  patients,
  query,
}: {
  db: Db;
  patients: { id: string; displayName: string | null }[];
  query: { transfer?: string; sent?: string; transferError?: string };
}) {
  let targets: { name: string; label: string }[] = [];
  let configError: string | null = null;
  try {
    targets = transferTargets();
  } catch (err) {
    if (!(err instanceof TransferTargetError)) throw err;
    configError = err.message;
  }
  const dryId = uuid(query.transfer);
  const sentId = uuid(query.sent);
  const [dry, sent] = await Promise.all([
    dryId ? db.transferJob.findUnique({ where: { id: dryId }, select: JOB }) : null,
    sentId ? db.transferJob.findUnique({ where: { id: sentId }, select: JOB }) : null,
  ]);
  const alreadySent = dry
    ? await db.transferJob.findUnique({ where: { approvedJobId: dry.id }, select: JOB })
    : null;
  const delivered = sent ?? alreadySent;
  const delivery = (delivered?.delivery ?? null) as Delivery | null;
  const byType = ((dry?.summary as { byType?: TypeRow[] } | null)?.byType ?? []) as TypeRow[];
  const targetLabel = (name: string | null) =>
    targets.find((t) => t.name === name)?.label ?? name ?? "the receiving EHR";

  return (
    <section aria-labelledby="transfer-h" id="transfer">
      <h2 id="transfer-h">Transfer between EHRs</h2>
      <p className="section-lede">
        Each patient&rsquo;s record came from an outside EHR (Synthea, received as FHIR and C-CDA).
        A transfer maps it to a US Core 6.1.0 transaction bundle. A dry run shows what would be
        kept, changed or lost. A provider then approves it, and MediSync sends exactly the approved
        bundle to the receiving EHR.
      </p>
      {configError ? <p className="notice">{configError}</p> : null}
      {query.transferError ? (
        <p className="notice" role="alert">
          {query.transferError}
        </p>
      ) : null}

      <form action={startDryRun} className="pick">
        <label htmlFor="transfer-patient">Patient</label>
        <select
          id="transfer-patient"
          name="patientId"
          defaultValue={dry?.patientId ?? patients[0]?.id}
        >
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName ?? p.id}
            </option>
          ))}
        </select>
        <button className="button-quiet" type="submit">
          1. Run dry run
        </button>
      </form>

      {dry ? (
        <>
          <h3>
            Dry run for {dry.patient.displayName ?? "patient"}: {dry.patient.sourceSystem} →{" "}
            {dry.targetProfile}
          </h3>
          {dry.status !== "SUCCEEDED" || !dry.dryRun ? (
            <p className="notice">
              This is not a successful dry run{dry.error ? ` (${dry.error})` : ""}.
            </p>
          ) : null}
          <ol className="stats">
            <li className="stat stat-done">
              <span className="stat-value">{pct(dry.completeness)}</span>
              <span className="stat-label">Completeness</span>
              <span className="stat-note">source elements kept or changed</span>
            </li>
            <li className="stat stat-done">
              <span className="stat-value">{dry.resourcesExported ?? "–"}</span>
              <span className="stat-label">Resources to send</span>
              <span className="stat-note">
                of {dry.resourcesSelected ?? "–"} selected, each with a Provenance
              </span>
            </li>
            <li className={`stat ${dry.resourcesExcluded ? "stat-next" : "stat-done"}`}>
              <span className="stat-value">{dry.resourcesExcluded ?? "–"}</span>
              <span className="stat-label">Excluded</span>
              <span className="stat-note">fail a US Core mandatory element</span>
            </li>
          </ol>
          <div className="table-scroll">
            <table className="ledger">
              <caption className="fine">Element-level diff by resource type</caption>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col" className="num">
                    To send
                  </th>
                  <th scope="col" className="num">
                    Kept
                  </th>
                  <th scope="col" className="num">
                    Changed
                  </th>
                  <th scope="col" className="num">
                    Lost
                  </th>
                  <th scope="col" className="num">
                    Completeness
                  </th>
                  {delivery?.created ? (
                    <th scope="col" className="num">
                      Created in {targetLabel(delivered!.target)}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {byType.map((t) => (
                  <tr key={t.type}>
                    <th scope="row">{t.type}</th>
                    <td className="num">
                      {t.exported}/{t.selected}
                    </td>
                    <td className="num">{t.kept}</td>
                    <td className="num">{t.changed}</td>
                    <td className={`num${t.lost ? "" : " zero"}`}>{t.lost}</td>
                    <td className="num">{pct(t.completeness)}</td>
                    {delivery?.created ? (
                      <td className="num">{delivery.created[t.type] ?? 0}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Full fidelity report</summary>
            <pre className="raw">{dry.report}</pre>
          </details>

          {delivered ? (
            <div aria-live="polite">
              {delivered.deliveredAt && delivery ? (
                <p className="sent" role="status">
                  <strong>Delivered to {targetLabel(delivered.target)}.</strong>{" "}
                  {Object.values(delivery.created).reduce((a, b) => a + b, 0)} resources created
                  (HTTP {delivery.httpStatus}); the patient is{" "}
                  <span className="mono">Patient/{delivery.targetPatientId}</span> there. Bundle{" "}
                  <span className="mono">{delivered.bundleSha256?.slice(0, 12)}</span> matches the
                  approved dry run.
                </p>
              ) : (
                <p className="notice" role="alert">
                  Not delivered to {targetLabel(delivered.target)}:{" "}
                  {delivery?.error ?? delivered.error}. Run a new dry run to try again.
                </p>
              )}
            </div>
          ) : dry.status === "SUCCEEDED" && dry.dryRun && targets.length ? (
            <form action={approveAndSend} className="pick">
              <input type="hidden" name="jobId" value={dry.id} />
              <label>
                <input type="checkbox" name="reviewed" value="yes" required /> I read the fidelity
                report and approve this transfer
              </label>
              <label htmlFor="transfer-target">to</label>
              <select id="transfer-target" name="target">
                {targets.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button className="button-quiet" type="submit">
                2. Approve and send
              </button>
            </form>
          ) : !targets.length && !configError ? (
            <p className="fine">
              No receiving EHR is configured. Set TRANSFER_TARGETS and TRANSFER_&lt;NAME&gt;_URL
              (see .env.example), and run the mock EHR B with{" "}
              <span className="mono">pnpm mock:ehrb</span>.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
