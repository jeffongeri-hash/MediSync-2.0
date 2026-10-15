"use client";
// Shown when a page or form action fails on the server. The error message is never shown (it can carry patient
// data); the reference is the digest Next.js logs with the error class.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
      {error.digest ? (
        <p className="fine">
          Reference <code>{error.digest}</code>
        </p>
      ) : null}
      <p>
        <button className="button" type="button" onClick={reset}>
          Try again
        </button>
      </p>
    </main>
  );
}
