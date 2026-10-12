import type { Metadata } from "next";
import Link from "next/link";
import { recordAudit } from "@/audit";
import { getDb } from "@/db";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import { RECONCILE_SOURCE } from "@/reconcile/run";
import { RECONCILE_WRITE_TYPES, supports, type CapabilitySummary } from "@/smart/capability";
import type { QueryOutcome } from "@/smart/fetch";
import { actorOf, LAUNCH_ERRORS } from "@/smart/launch";
import { currentSession } from "@/smart/next";
import { startSmartRun } from "./actions";
import { LaunchBanner } from "./banner";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MediSync SMART launch" };

const ERRORS: Record<string, string> = {
  ...LAUNCH_ERRORS,
  outside_record: "Pick one of the synthetic outside records.",
};

const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
function NotLaunched() {
  return (
    <>
      <p>
        No completed launch in this browser. In the EHR, open MediSync from the patient&apos;s chart
        (EHR launch), or start a standalone launch below and choose a test patient at the EHR&apos;s
        sign-in.
      </p>
      <p>
        <a className="button" href="/smart/login">
          Standalone launch
        </a>
      </p>
      <p className="fine">
        EHR launch URL: <span className="mono">/smart/launch</span> · redirect URI:{" "}
        <span className="mono">/smart/callback</span>. Setup steps: docs/EPIC_SANDBOX.md.
      </p>
    </>
  );
}

export default async function SmartPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await currentSession();
  const db = getDb();
  const ready = session?.authorizedAt && session.patientId ? session : null;

  const patient = ready
    ? await db.patient.findUnique({
        where: { id: ready.patientId! },
        select: { id: true, displayName: true },
      })
    : null;
  const outside = ready
    ? await db.patient.findMany({
        where: { sourceSystem: SYNTHEA_SOURCE, sourceRecords: { some: { format: "CCDA" } } },
        orderBy: { displayName: "asc" },
        select: { id: true, displayName: true, sourcePatientId: true },
      })
    : [];
  const latestRun = ready
    ? await db.reconciliationRun.findFirst({
        where: { patientId: ready.patientId! },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, incomingPatientId: true },
      })
    : null;
  if (ready && patient)
    await recordAudit(db, {
      actor: actorOf(ready),
      action: "READ",
      patientId: patient.id,
      entityType: "Patient",
      entityId: patient.id,
      source: RECONCILE_SOURCE,
      details: { view: "smart" },
    });

  const fetchSummary = (ready?.fetchSummary ?? {}) as {
    queries?: QueryOutcome[];
    capability?: CapabilitySummary | null;
  };
  // Pre-select the outside record of the same synthetic person when the launch server serves Synthea ids.
  const suggested =
    latestRun?.incomingPatientId ??
    outside.find((o) => o.sourcePatientId === ready?.fhirPatientId)?.id ??
    "";

  return (
    <main className="page">
      <header className="masthead">
        <div className="masthead-row">
          <p className="eyebrow">MediSync · Phase 5 SMART launch</p>
          <span className="pill pill-synthetic">Synthetic data only</span>
        </div>
        <h1>{patient?.displayName ?? "SMART on FHIR launch"}</h1>
        <p className="lede">
          MediSync reads the launched patient&apos;s chart from the EHR (problems, medications,
          allergies, encounters) and reconciles it against an outside record. Nothing is written
          back to the EHR in this phase.
        </p>
      </header>
      {error ? (
        <p className="notice">{ERRORS[error] ?? "The launch failed. Launch again."}</p>
      ) : null}
      {!ready ? (
        <NotLaunched />
      ) : (
        <>
          <LaunchBanner session={ready} name={patient?.displayName ?? null} />

          <section aria-labelledby="read-h">
            <h2 id="read-h">Read at launch</h2>
            <p className="section-lede">
              Granted scope: <span className="mono">{ready.scope ?? "not reported"}</span>
            </p>
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Query</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="num">
                      Resources
                    </th>
                    <th scope="col" className="num">
                      Requests
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(fetchSummary.queries ?? []).map((q) => (
                    <tr key={q.label}>
                      <th scope="row" className="mono">
                        {q.label}
                      </th>
                      <td>{q.ok ? "ok" : `failed (${q.error ?? "error"})`}</td>
                      <td className="num">{q.count}</td>
                      <td className="num">{q.pages}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="reconcile-h">
            <h2 id="reconcile-h">Reconcile an outside record</h2>
            <p className="section-lede">
              The chart read above is the current side. Pick the outside record (a synthetic Synthea
              C-CDA) to compare it with.
            </p>
            <form action={startSmartRun} className="pick">
              <label htmlFor="incomingPatientId">Outside record</label>
              <select
                id="incomingPatientId"
                name="incomingPatientId"
                defaultValue={suggested}
                required
              >
                <option value="" disabled>
                  Choose a synthetic C-CDA
                </option>
                {outside.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.displayName ?? o.id} (C-CDA)
                  </option>
                ))}
              </select>
              <button className="button" type="submit">
                Start reconciliation
              </button>
            </form>
            {latestRun ? (
              <p className="fine">
                Latest run {when(latestRun.createdAt)} ·{" "}
                <Link href={`/reconcile/${ready.patientId}`}>open the review</Link>
              </p>
            ) : null}
          </section>

          <section aria-labelledby="write-h">
            <h2 id="write-h">Write-back the server declares</h2>
            {fetchSummary.capability ? (
              <>
                <p className="section-lede">
                  From <span className="mono">{fetchSummary.capability.iss}/metadata</span> (
                  {fetchSummary.capability.software ?? "software not stated"}). Run{" "}
                  <span className="mono">pnpm smart:capability</span> for the full report.
                </p>
                <div className="table-scroll">
                  <table className="ledger">
                    <thead>
                      <tr>
                        <th scope="col">Type</th>
                        <th scope="col">create</th>
                        <th scope="col">update</th>
                      </tr>
                    </thead>
                    <tbody>
                      {RECONCILE_WRITE_TYPES.map((t) => (
                        <tr key={t}>
                          <th scope="row">{t}</th>
                          <td>{supports(fetchSummary.capability!, t, "create") ? "yes" : "-"}</td>
                          <td>{supports(fetchSummary.capability!, t, "update") ? "yes" : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p>The server&apos;s CapabilityStatement could not be read at launch.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
