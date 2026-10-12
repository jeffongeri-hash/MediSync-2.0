import type { Metadata } from "next";
import Link from "next/link";
import { recordAudit } from "@/audit";
import { getDb } from "@/db";
import { SYNTHEA_SOURCE } from "@/ingest/seed";
import { RECONCILE_SOURCE } from "@/reconcile/run";
import { startRun } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MediSync Reconcile" };

const ACTOR = "demo:provider";
const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export default async function ReconcileIndex() {
  const db = getDb();
  // Seeded patients only: a patient read through a SMART launch opens from that launch (/smart), never from a list.
  const patients = await db.patient.findMany({
    where: { sourceSystem: SYNTHEA_SOURCE },
    orderBy: { displayName: "asc" },
    select: {
      id: true,
      displayName: true,
      reconciliationRuns: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          createdAt: true,
          responder: true,
          summary: true,
          _count: { select: { decisions: true } },
        },
      },
    },
  });
  await recordAudit(
    db,
    patients.map((p) => ({
      actor: ACTOR,
      action: "READ" as const,
      patientId: p.id,
      entityType: "Patient",
      entityId: p.id,
      source: RECONCILE_SOURCE,
    })),
  );

  return (
    <main className="page">
      <header className="masthead">
        <div className="masthead-row">
          <p className="eyebrow">MediSync · Phase 4 reconciliation</p>
          <span className="pill pill-synthetic">Synthetic data · Synthea</span>
        </div>
        <h1>Reconcile outside records</h1>
        <p className="lede">
          For each patient, the C-CDA received from an outside organization is compared with the
          chart as it stood twelve months before the latest encounter. Rules flag conflicts and
          duplicates; a summary cites the records it rests on; a provider accepts, rejects or edits
          each line.
        </p>
      </header>
      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Patient</th>
              <th scope="col">Latest run</th>
              <th scope="col">Flags</th>
              <th scope="col">Decisions</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => {
              const run = p.reconciliationRuns[0];
              const flags = Object.values(
                ((run?.summary ?? {}) as { flags?: Record<string, number> }).flags ?? {},
              );
              return (
                <tr key={p.id}>
                  <th scope="row">
                    <Link className="name" href={`/reconcile/${p.id}`}>
                      {p.displayName ?? p.id}
                    </Link>
                  </th>
                  <td>{run ? `${when(run.createdAt)} · ${run.responder}` : "None yet"}</td>
                  <td className="num">{run ? flags.reduce((a, b) => a + b, 0) : "–"}</td>
                  <td className="num">{run ? run._count.decisions : "–"}</td>
                  <td>
                    <form action={startRun}>
                      <input type="hidden" name="patientId" value={p.id} />
                      <button className="button-quiet" type="submit">
                        {run ? "Run again" : "Run"}
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fine">
        Decisions are recorded and audited. Nothing is written to the chart in this phase.
      </p>
    </main>
  );
}
