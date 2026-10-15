"use client";
// Last-resort boundary for errors in the root layout itself; it replaces the whole document.
import "./globals.css";
import { ErrorView } from "./error-view";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <ErrorView digest={error.digest} />
      </body>
    </html>
  );
}
