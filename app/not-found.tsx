import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found · MediSync" };

export default function NotFound() {
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">MediSync</p>
        <h1>Page not found</h1>
        <p className="lede">
          The link may be out of date. A patient read from an EHR opens only inside the launch that
          read it, so open MediSync again from that patient&apos;s chart.
        </p>
      </header>
      <p>
        <Link className="button" href="/">
          Go to the start page
        </Link>
      </p>
    </main>
  );
}
