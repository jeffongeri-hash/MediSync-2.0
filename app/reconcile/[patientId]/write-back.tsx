// Dry-run write-back for a launched patient: what the accepted and edited lines would write to the EHR, and by which
// path, given the CapabilityStatement read at launch. Nothing is sent.
import { getDb } from "@/db";
import type { CapabilitySummary } from "@/smart/capability";
import type { SmartSession } from "@/smart/session";
import { buildWritePackage, loadWriteItems } from "@/smart/writeback";

export async function WriteBack({ session, runId }: { session: SmartSession; runId: string }) {
  const capability =
    ((session.fetchSummary ?? {}) as { capability?: CapabilitySummary | null }).capability ?? null;
  const pkg = buildWritePackage({
    runId,
    items: await loadWriteItems(getDb(), runId),
    capability,
    fhirPatientId: session.fhirPatientId ?? "",
    now: new Date(),
  });
  const viaFhir = pkg.candidates.filter((c) => c.path === "fhir").length;
  return (
    <section aria-labelledby="writeback-h">
      <h2 id="writeback-h">Write-back (dry run, not sent)</h2>
      <p className="section-lede">
        {pkg.candidates.length === 0
          ? "No accepted or edited line would change the chart yet."
          : `${pkg.candidates.length} line(s) would change the chart: ${viaFhir} by a FHIR write the server declares, ${
              pkg.candidates.length - viaFhir
            } only through the export package.`}{" "}
        <a href={`/smart/writeback/${runId}`}>Download the package (JSON)</a>
      </p>
      {pkg.candidates.length > 0 ? (
        <div className="table-scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Decision</th>
                <th scope="col">Would</th>
                <th scope="col">Path</th>
              </tr>
            </thead>
            <tbody>
              {pkg.candidates.map((c) => (
                <tr key={c.itemId}>
                  <th scope="row">{c.display}</th>
                  <td>{c.decision}</td>
                  <td className="mono">
                    {c.interaction} {c.resourceType}
                  </td>
                  <td>
                    {c.path === "fhir" ? "FHIR write" : "Export package only"}{" "}
                    <span className="row-meta">{c.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
