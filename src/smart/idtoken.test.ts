import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyIdToken, type FetchJson } from "@/smart/idtoken";

const ISS = "https://ehr.example/fhir/r4";
const OIDC = "https://ehr.example/oauth2";
const NOW = new Date("2026-10-15T12:00:00Z");
const t = Math.floor(NOW.getTime() / 1000);
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(
  claims: Record<string, unknown>,
  opts: { alg?: string; kid?: string; key?: KeyObject } = {},
) {
  const alg = opts.alg ?? "RS256";
  const data = `${b64({ alg, kid: opts.kid ?? (alg === "ES256" ? "ec-1" : "rsa-1"), typ: "JWT" })}.${b64(
    {
      iss: OIDC,
      sub: "u1",
      aud: "client-1",
      iat: t - 10,
      exp: t + 300,
      fhirUser: `${ISS}/Practitioner/abc`,
      ...claims,
    },
  )}`;
  const key = opts.key ?? (alg === "ES256" ? ec.privateKey : rsa.privateKey);
  const sig =
    alg === "ES256"
      ? sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", Buffer.from(data), key);
  return `${data}.${sig.toString("base64url")}`;
}
const jwks = {
  keys: [
    { ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1" },
    { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1" },
  ],
};
const fetchFrom =
  (jwksUri = `${OIDC}/jwks`, issuer = OIDC): FetchJson =>
  async (url) => {
    if (url === `${OIDC}/.well-known/openid-configuration`) return { issuer, jwks_uri: jwksUri };
    if (url === jwksUri) return jwks;
    throw new Error(`unexpected fetch ${url}`);
  };
const check = (token: unknown, fetchJson = fetchFrom()) =>
  verifyIdToken(token, { iss: ISS, clientId: "client-1", fetchJson, now: NOW });

describe("id_token verification", () => {
  it("accepts RS256 and ES256 tokens signed by the issuer's published key", async () => {
    expect(await check(jwt({}))).toEqual({
      ok: true,
      fhirUser: `${ISS}/Practitioner/abc`,
      sub: "u1",
    });
    expect(await check(jwt({}, { alg: "ES256" }))).toMatchObject({ ok: true });
  });

  it("resolves a relative fhirUser against the server and drops one that is not a FHIR reference", async () => {
    expect(await check(jwt({ fhirUser: "Practitioner/xyz" }))).toMatchObject({
      fhirUser: `${ISS}/Practitioner/xyz`,
    });
    expect(await check(jwt({ fhirUser: "javascript:alert(1)" }))).toMatchObject({
      ok: true,
      fhirUser: null,
    });
    expect(await check(jwt({ fhirUser: undefined, profile: "Patient/p1" }))).toMatchObject({
      fhirUser: `${ISS}/Patient/p1`,
    });
  });

  it("rejects a forged signature, the wrong audience, an expired token and unsupported algorithms", async () => {
    expect(await check(jwt({}, { key: other.privateKey }))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await check(jwt({ aud: "someone-else" }))).toEqual({ ok: false, reason: "claims" });
    expect(await check(jwt({ exp: t - 3600 }))).toEqual({ ok: false, reason: "claims" });
    expect(await check(jwt({ iat: t + 3600 }))).toEqual({ ok: false, reason: "claims" });
    const [h, p] = jwt({}).split(".");
    const none = `${b64({ alg: "none" })}.${p}.`;
    expect(await check(none)).toEqual({ ok: false, reason: "alg" });
    expect(await check(`${h}.${p}`)).toEqual({ ok: false, reason: "malformed" });
    expect(await check(undefined)).toEqual({ ok: false, reason: "missing" });
  });

  it("only trusts discovery and keys on the SMART server's own origin", async () => {
    expect(await check(jwt({ iss: "https://evil.example/oauth2" }))).toEqual({
      ok: false,
      reason: "issuer",
    });
    expect(await check(jwt({}), fetchFrom("https://evil.example/jwks"))).toEqual({
      ok: false,
      reason: "issuer",
    });
    expect(await check(jwt({}), fetchFrom(undefined, "https://ehr.example/other"))).toEqual({
      ok: false,
      reason: "issuer",
    });
    expect(
      await check(jwt({}), async () => {
        throw new Error("offline");
      }),
    ).toEqual({ ok: false, reason: "discovery" });
    expect(await check(jwt({}, { kid: "unknown" }))).toEqual({ ok: false, reason: "key" });
  });
});
