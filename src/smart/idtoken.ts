// id_token verification (Phase 6; Phase 5 read the claims unchecked). The token endpoint's id_token is checked as
// OIDC Core 3.1.3.7 describes: an RS256 or ES256 signature against the issuer's JWKS (found through
// {iss}/.well-known/openid-configuration), iss, aud = our client id, exp and iat. Discovery and keys are fetched only
// from the SMART server's own origin. A launch whose id_token fails keeps going without a user, which makes it
// read-only (viewer); the reason code is kept in the session's fetch summary.
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { z } from "zod";

export type IdTokenCheck =
  | { ok: true; fhirUser: string | null; sub: string }
  | {
      ok: false;
      reason:
        "missing" | "malformed" | "alg" | "issuer" | "discovery" | "key" | "signature" | "claims";
    };

export type FetchJson = (url: string) => Promise<unknown>;

const SKEW_S = 120;

const header = z.object({ alg: z.string(), kid: z.string().optional() });
const claims = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  fhirUser: z.string().optional(),
  profile: z.string().optional(),
});
const discovery = z.object({ issuer: z.string(), jwks_uri: z.string() });
const jwks = z.object({
  keys: z.array(z.object({ kty: z.string(), kid: z.string().optional() }).passthrough()),
});

const json = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
const sameOrigin = (url: string, iss: string) => {
  try {
    return new URL(url).origin === new URL(iss).origin;
  } catch {
    return false;
  }
};
// A FHIR reference to the user: absolute, or relative to the server (resolved, so ids from two EHRs never collide).
const FHIR_USER =
  /^(https?:\/\/[^\s]+\/)?(Practitioner|PractitionerRole|Patient|RelatedPerson|Person)\/[A-Za-z0-9\-.]{1,64}$/;

export async function verifyIdToken(
  token: unknown,
  opts: { iss: string; clientId: string; fetchJson: FetchJson; now?: Date },
): Promise<IdTokenCheck> {
  if (typeof token !== "string" || !token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  let h: z.infer<typeof header>;
  let c: z.infer<typeof claims>;
  try {
    if (parts.length !== 3) throw new Error("parts");
    h = header.parse(json(parts[0]!));
    c = claims.parse(json(parts[1]!));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (h.alg !== "RS256" && h.alg !== "ES256") return { ok: false, reason: "alg" };
  if (!sameOrigin(c.iss, opts.iss)) return { ok: false, reason: "issuer" };

  let keys: z.infer<typeof jwks>["keys"];
  try {
    const d = discovery.parse(
      await opts.fetchJson(`${c.iss.replace(/\/+$/, "")}/.well-known/openid-configuration`),
    );
    if (
      d.issuer.replace(/\/+$/, "") !== c.iss.replace(/\/+$/, "") ||
      !sameOrigin(d.jwks_uri, opts.iss)
    )
      return { ok: false, reason: "issuer" };
    keys = jwks.parse(await opts.fetchJson(d.jwks_uri)).keys;
  } catch {
    return { ok: false, reason: "discovery" };
  }
  const kty = h.alg === "RS256" ? "RSA" : "EC";
  const candidates = keys.filter((k) => k.kty === kty && (h.kid === undefined || k.kid === h.kid));
  if (candidates.length !== 1) return { ok: false, reason: "key" };
  let valid = false;
  try {
    const key = createPublicKey({ key: candidates[0] as JsonWebKey, format: "jwk" });
    valid = verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      h.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key,
      Buffer.from(parts[2]!, "base64url"),
    );
  } catch {
    return { ok: false, reason: "key" };
  }
  if (!valid) return { ok: false, reason: "signature" };

  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId) || c.exp < now - SKEW_S || c.iat > now + SKEW_S)
    return { ok: false, reason: "claims" };
  const raw = c.fhirUser ?? c.profile;
  const fhirUser = raw && FHIR_USER.test(raw) ? new URL(raw, `${opts.iss}/`).href : null;
  return { ok: true, fhirUser, sub: c.sub };
}

/** Discovery and JWKS (already limited to the SMART server's origin): JSON, 10 s, no redirects. */
export const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
