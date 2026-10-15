import Link from "next/link";
import { demoMode } from "@/security/roles";

// Reads DEMO_MODE per request, not at build time.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">MediSync</p>
        <h1>Move a patient&apos;s record between EHRs, then reconcile what arrives.</h1>
        <p className="lede">
          A SMART on FHIR app for Epic. It ingests outside records, maps them to FHIR R4, and puts
          every incoming medication, problem and allergy in front of a provider before anything
          touches the chart.
        </p>
      </header>
      {demoMode() ? (
        <p>
          <Link className="button" href="/demo">
            Open the intake demo
          </Link>{" "}
          <Link className="button" href="/reconcile">
            Reconcile outside records
          </Link>
        </p>
      ) : (
        <p>
          Open MediSync from a patient&apos;s chart in your EHR. The launch signs you in and opens
          that patient.
        </p>
      )}
      <p className="fine">
        Synthetic data only (Synthea). No real patient information is used anywhere.
      </p>
    </main>
  );
}
