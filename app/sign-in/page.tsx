import type { Metadata } from "next";
import Link from "next/link";
import { accessConfigured } from "@/access";
import { signIn } from "./actions";

export const metadata: Metadata = { title: "MediSync sign in" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = error && error.length <= 200 ? error : null;
  if (!accessConfigured()) {
    return (
      <main className="page">
        <h1>Sign in</h1>
        <p className="lede">No access tokens are set, so the synthetic demo is open.</p>
        <p>
          <Link className="button" href="/">
            Back home
          </Link>
        </p>
      </main>
    );
  }
  return (
    <main className="page">
      <header className="masthead">
        <h1>Sign in</h1>
        <p className="lede">
          Use a reviewer or exporter token. An auditor token is for the audit export API, not these
          pages.
        </p>
      </header>
      {message ? (
        <p className="notice" role="alert">
          {message}
        </p>
      ) : null}
      <form action={signIn} className="sign-in">
        <label htmlFor="token">Access token</label>
        <input id="token" name="token" type="password" autoComplete="current-password" required />
        <button className="button" type="submit">
          Sign in
        </button>
      </form>
    </main>
  );
}
