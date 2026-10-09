import Link from "next/link";

export default function Home() {
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">MediSync</p>
        <h1>Move a patient&apos;s record between EHRs, then reconcile what arrives.</h1>
        <p className="lede">
          A SMART on FHIR app for Epic. It ingests outside records, maps them to FHIR R4, and puts every
          incoming medication, problem and allergy in front of a provider before anything touches the chart.
        </p>
      </header>
      <p>
        <Link className="button" href="/demo">
          Open the intake demo
        </Link>
      </p>
      <p className="fine">Synthetic data only (Synthea). No real patient information is used anywhere.</p>
    </main>
  );
}
