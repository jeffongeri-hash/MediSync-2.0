import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { pageActor } from "@/access/session";
import { getDb } from "@/db";
import { CATEGORIES, type Category, type MatchKind, type RuleFlag } from "@/reconcile/build";
import { day, type ReconRow } from "@/reconcile/rows";
import { loadRunView, type RunView } from "@/reconcile/run";
import { decide, startRun } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MediSync Reconcile" };

const CATEGORY_LABEL: Record<Category, string> = {
  PROBLEM: "Problems",
  MEDICATION: "Medications",
  ALLERGY: "Allergies",
  PMH: "Past medical history",
};
const MATCH_LABEL: Record<MatchKind, string> = {
  CHANGED: "Differs",
  NEW: "New from outside record",
  CURRENT_ONLY: "Only in current chart",
  SAME: "Same in both",
};
const TOPIC_LABEL: Record<string, string> = {
  active_problem: "Active problems",
  medication: "Medications",
  allergy: "Allergies",
  past_history: "Past history",
};
const RESPONDER_LABEL: Record<string, string> = {
  anthropic: "Claude",
  replay: "Recorded Claude response",
  template: "Rule-built summary (no API key configured; the Claude summary is optional)",
};

const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

function RowCell({ row }: { row: ReconRow | null }) {
  if (!row) return <td className="side-empty">Not in this record</td>;
  const reactions = row.reactions
    .map((r) => (r.severity ? `${r.manifestation} (${r.severity})` : r.manifestation))
    .join("; ");
  const meta = [
    row.status && `${row.status}${row.asOfCutoff ? " at cutoff" : ""}`,
    row.start && `${row.family === "medication" ? "start" : "onset"} ${day(row.start)}`,
    row.end && `end ${day(row.end)}`,
    row.dose && `dose ${row.dose}`,
    row.dosageText,
    row.criticality && `criticality ${row.criticality}`,
    reactions && `reaction: ${reactions}`,
  ].filter(Boolean);
  return (
    <td>
      <span className="row-name">{row.display}</span>
      <span className="row-meta">{meta.join(" · ")}</span>
      <span className="row-meta mono">{row.resourceType}</span>
    </td>
  );
}

function Flags({ flags }: { flags: RuleFlag[] }) {
  if (flags.length === 0) return <span className="subtle">None</span>;
  return flags.map((f, i) => (
    <span key={i} className={`flag flag-${f.severity}`}>
      <strong>{f.code.replaceAll("_", " ")}</strong> {f.message}
    </span>
  ));
}

function Decision({
  d,
}: {
  d: { action: string; actor: string; decidedAt: Date; note: string | null } | null;
}) {
  if (!d) return <span className="decision">Not reviewed</span>;
  return (
    <span className="decision">
      {d.action === "EDIT" ? "Edited copy saved" : d.action === "ACCEPT" ? "Accepted" : "Rejected"}{" "}
      by {d.actor}, {when(d.decidedAt)}
      {d.note ? ` (${d.note})` : ""}
    </span>
  );
}

function Hidden({ values }: { values: Record<string, string> }) {
  return Object.entries(values).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
}

function Summary({ run, patientId }: { run: RunView; patientId: string }) {
  const itemOf = new Map(
    run.items.flatMap((it) =>
      [it.currentId, it.incomingId].flatMap((id) => (id ? [[id, it.ordinal]] : [])),
    ),
  );
  const valid = run.claims.filter((c) => c.valid);
  const dropped = run.claims.filter((c) => !c.valid);
  const groups = [
    ...Object.keys(TOPIC_LABEL).map((t) => ({
      label: TOPIC_LABEL[t]!,
      claims: valid.filter((c) => c.kind === "SUMMARY" && c.topic === t),
    })),
    {
      label: "AI flags (suggestions, beyond the rules)",
      claims: valid.filter((c) => c.kind === "FLAG"),
    },
  ].filter((g) => g.claims.length > 0);
  return (
    <section aria-labelledby="summary">
      <h2 id="summary">Summary</h2>
      <p className="section-lede">
        {RESPONDER_LABEL[run.responder] ?? run.responder}
        {run.servedModel ? ` · ${run.servedModel}` : run.model ? ` · ${run.model}` : ""}
        {run.promptVersion ? ` · ${run.promptVersion}` : ""}. A suggestion only: every statement
        cites the records it rests on, and statements that failed the citation or condition check
        are dropped.
      </p>
      {run.aiError ? (
        <p className="notice" role="alert">
          The summary could not be produced ({run.aiError}).
        </p>
      ) : null}
      {groups.map((g) => (
        <div key={g.label}>
          <h3>{g.label}</h3>
          <ul className="claims">
            {g.claims.map((c) => (
              <li key={c.id} className="claim" id={`claim-${c.ordinal}`}>
                <p>{c.text}</p>
                <p>
                  {c.citedAliases.map((a, i) => (
                    <a key={a} className="cite" href={`#item-${itemOf.get(c.sourceIds[i]!) ?? ""}`}>
                      {a}
                    </a>
                  ))}
                </p>
                <Decision d={c.decision} />
                <form action={decide} className="decide">
                  <Hidden
                    values={{
                      patientId,
                      runId: run.id,
                      claimId: c.id,
                      anchor: `claim-${c.ordinal}`,
                    }}
                  />
                  <button
                    type="submit"
                    name="action"
                    value="ACCEPT"
                    aria-label={`Accept ${g.label} statement`}
                  >
                    Accept
                  </button>
                  <button
                    type="submit"
                    name="action"
                    value="REJECT"
                    aria-label={`Reject ${g.label} statement`}
                  >
                    Reject
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {dropped.length > 0 ? (
        <details className="source">
          <summary>
            <span className="name">{dropped.length} dropped statement(s)</span>
          </summary>
          <ul>
            {dropped.map((c) => (
              <li key={c.id}>
                {c.text} <span className="mono subtle">({c.problems.join(", ")})</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function CategoryTable({
  run,
  category,
  patientId,
}: {
  run: RunView;
  category: Category;
  patientId: string;
}) {
  const items = run.items.filter((it) => it.category === category);
  if (items.length === 0) return null;
  const counts = Object.entries(
    items.reduce<Record<string, number>>(
      (m, it) => ((m[it.match] = (m[it.match] ?? 0) + 1), m),
      {},
    ),
  )
    .map(([m, n]) => `${n} ${MATCH_LABEL[m as MatchKind].toLowerCase()}`)
    .join(" · ");
  return (
    <section aria-labelledby={`cat-${category}`}>
      <h2 id={`cat-${category}`}>{CATEGORY_LABEL[category]}</h2>
      <p className="section-lede">{counts}</p>
      <div
        className="table-scroll"
        tabIndex={0}
        role="region"
        aria-label={CATEGORY_LABEL[category]}
      >
        <table className="ledger recon">
          <thead>
            <tr>
              <th scope="col">Current chart (as of cutoff)</th>
              <th scope="col">Incoming (outside record)</th>
              <th scope="col">Flags</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id} id={`item-${it.ordinal}`}>
                <RowCell row={it.current} />
                <RowCell row={it.incoming} />
                <td>
                  <span className="decision">{MATCH_LABEL[it.match]}</span>
                  <Flags flags={it.flags} />
                </td>
                <td>
                  <Decision d={it.decision} />
                  <form action={decide} className="decide">
                    <Hidden
                      values={{
                        patientId,
                        runId: run.id,
                        itemId: it.id,
                        anchor: `item-${it.ordinal}`,
                      }}
                    />
                    <button
                      type="submit"
                      name="action"
                      value="ACCEPT"
                      aria-label={`Accept ${it.incoming?.display ?? it.current?.display ?? "this line"}`}
                    >
                      Accept
                    </button>
                    <button
                      type="submit"
                      name="action"
                      value="REJECT"
                      aria-label={`Reject ${it.incoming?.display ?? it.current?.display ?? "this line"}`}
                    >
                      Reject
                    </button>
                    <Link className="button-quiet" href={`/reconcile/${patientId}/items/${it.id}`}>
                      Edit
                    </Link>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { patientId } = await params;
  const { error: errorParam } = await searchParams;
  const error = errorParam && errorParam.length <= 200 ? errorParam : null;
  if (!z.uuid().safeParse(patientId).success) notFound();
  const db = getDb();
  const patient = await db.patient.findUnique({ where: { id: patientId } });
  if (!patient) notFound();
  const actor = (await pageActor("transfer.dryRun")).actor;
  const run = await loadRunView(db, { patientId, actor });

  return (
    <main className="page">
      <header className="masthead">
        <div className="masthead-row">
          <p className="eyebrow">
            <Link href="/reconcile">MediSync · Reconciliation</Link>
          </p>
          <span className="pill pill-synthetic">Synthetic data · Synthea</span>
        </div>
        <h1>{patient.displayName ?? "Patient"}</h1>
        <p className="lede">
          The current chart is this patient&apos;s FHIR bundle as it stood on the cutoff date.
          Incoming is the C-CDA from the outside organization. Accept takes the incoming version (or
          confirms the current one when there is no incoming row), reject keeps the chart as it is,
          and edit saves a provider-authored copy. Decisions are recorded and audited; nothing is
          written to the chart in this phase.
        </p>
        {run ? (
          <p className="fine">
            Cutoff {day(run.cutoff.toISOString())} · run {when(run.createdAt)} by {run.requestedBy}{" "}
            · {run.rulesVersion}
          </p>
        ) : null}
        <form action={startRun}>
          <input type="hidden" name="patientId" value={patientId} />
          <button className="button" type="submit">
            {run ? "Run reconciliation again" : "Run reconciliation"}
          </button>
        </form>
      </header>
      {error ? (
        <p className="notice" role="alert">
          {error}
        </p>
      ) : null}
      {run ? (
        <>
          <Summary run={run} patientId={patientId} />
          {CATEGORIES.map((c) => (
            <CategoryTable key={c} run={run} category={c} patientId={patientId} />
          ))}
        </>
      ) : (
        <p>No reconciliation has been run for this patient yet.</p>
      )}
    </main>
  );
}
