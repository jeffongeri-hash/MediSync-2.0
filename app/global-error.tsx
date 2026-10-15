"use client";
// Last-resort boundary for errors in the root layout itself; it replaces the whole document.
import "./globals.css";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <main className="page">
          <h1>MediSync could not start this page</h1>
          <p className="lede">
            Reload the page. If it keeps failing, give your administrator the reference below.
          </p>
          {error.digest ? (
            <p className="fine">
              Reference <code>{error.digest}</code>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
