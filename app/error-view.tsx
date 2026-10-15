// Shared body of the error pages (error.tsx, global-error.tsx). The error message is never shown: it can carry
// patient data. The reference is the digest Next.js logs next to the error class.
import Link from "next/link";

export function ErrorView({ digest, reset }: { digest?: string; reset?: () => void }) {
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">MediSync</p>
        <h1>This page could not be loaded</h1>
        <p className="lede">
          The server hit an error. Try again to reload the latest state; anything already recorded
          stays recorded. If it keeps failing, give your administrator the reference below.
        </p>
      </header>
      {digest ? (
        <p className="fine">
          Reference <code>{digest}</code>
        </p>
      ) : null}
      <p>
        {reset ? (
          <button className="button" type="button" onClick={reset}>
            Try again
          </button>
        ) : (
          <Link className="button" href="/">
            Go to the start page
          </Link>
        )}
      </p>
    </main>
  );
}
