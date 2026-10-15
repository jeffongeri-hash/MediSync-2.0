"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="page">
      <h1>Something went wrong</h1>
      <p className="lede">The page could not be shown. Try again.</p>
      {error.digest ? <p className="fine">Reference {error.digest}</p> : null}
      <p>
        <button className="button" type="button" onClick={() => reset()}>
          Try again
        </button>
      </p>
    </main>
  );
}
