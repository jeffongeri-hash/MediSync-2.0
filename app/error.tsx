"use client";
// Shown when a page or form action fails on the server.
import { ErrorView } from "./error-view";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorView digest={error.digest} reset={reset} />;
}
