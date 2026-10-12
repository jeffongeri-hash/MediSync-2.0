import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { recordAudit } from "@/audit";
import { getDb } from "@/db";
import type { ReconRow } from "@/reconcile/rows";
import { RECONCILE_SOURCE } from "@/reconcile/run";
import { patientAccess } from "@/smart/next";
import { decide } from "../../../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "MediSync Reconcile · Edit" };

// Edit = a provider-authored copy of the incoming row (or the current one when there is none), validated against the
// canonical schema on save. The copy is stored on the decision; canonical rows are never written.
export default async function EditItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string; itemId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { patientId, itemId } = await params;
  const { error } = await searchParams;
  if (!z.uuid().safeParse(patientId).success || !z.uuid().safeParse(itemId).success) notFound();
  const db = getDb();
  const patient = await db.patient.findUnique({
    where: { id: patientId },
    select: { id: true, sourceSystem: true },
  });
  if (!patient) notFound();
  const access = await patientAccess(patient);
  if (!access) notFound();
  const item = await db.reconciliationItem.findFirst({
    where: { id: itemId, run: { patientId } },
    include: { run: { select: { id: true } } },
  });
  if (!item) notFound();
  const sourceId = item.incomingId ?? item.currentId!;
  const source = await db.canonicalResource.findUniqueOrThrow({ where: { id: sourceId } });
  const latestEdit = await db.reconciliationDecision.findFirst({
    where: { itemId, action: "EDIT" },
    orderBy: { id: "desc" },
  });
  await recordAudit(db, {
    actor: access.actor,
    action: "READ",
    // The row read may be the outside record's (another patient index row in a SMART launch run).
    patientId: source.patientId,
    entityType: source.resourceType,
    entityId: source.id,
    source: RECONCILE_SOURCE,
  });
  const shown = (item.incoming ?? item.current) as unknown as ReconRow;
  const draft = JSON.stringify(
    latestEdit?.editedResource ?? source.mapped ?? source.resource,
    null,
    2,
  );

  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">
          <Link href={`/reconcile/${patientId}#item-${item.ordinal}`}>Back to reconciliation</Link>
        </p>
        <h1>Edit: {shown.display}</h1>
        <p className="lede">
          Change the {shown.resourceType} below and save. The copy must pass the same FHIR R4 checks
          as ingested records. It is saved as your decision on this line, not written to the chart.
        </p>
      </header>
      {error ? <p className="notice">{error}</p> : null}
      <form action={decide}>
        <input type="hidden" name="patientId" value={patientId} />
        <input type="hidden" name="runId" value={item.run.id} />
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="anchor" value={`item-${item.ordinal}`} />
        <input type="hidden" name="action" value="EDIT" />
        <label htmlFor="edited" className="stat-label">
          {shown.resourceType} JSON
        </label>
        <textarea
          id="edited"
          name="edited"
          className="edit-json"
          defaultValue={draft}
          spellCheck={false}
        />
        <p>
          <label htmlFor="note" className="stat-label">
            Note (optional)
          </label>
          <br />
          <input id="note" name="note" maxLength={500} size={60} />
        </p>
        <button className="button" type="submit">
          Save edited copy
        </button>
      </form>
    </main>
  );
}
