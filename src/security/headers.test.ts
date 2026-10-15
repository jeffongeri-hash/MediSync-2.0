import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, frameAncestors, securityHeaders } from "@/security/headers";
import { sessionCookie } from "@/smart/session";

const two = {
  SMART_SERVERS: "epic,oracle",
  SMART_EPIC_ISS: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
  SMART_EPIC_CLIENT_ID: "a",
  SMART_ORACLE_ISS: "https://fhir-ehr-code.cerner.com/r4/tenant",
  SMART_ORACLE_CLIENT_ID: "b",
};

describe("security headers", () => {
  it("lets only the configured EHRs frame the app, defaulting to each iss origin", () => {
    expect(frameAncestors(two)).toEqual([
      "https://fhir-ehr-code.cerner.com",
      "https://fhir.epic.com",
    ]);
    expect(
      frameAncestors({
        ...two,
        SMART_ORACLE_FRAME_ANCESTORS:
          "https://*.cerner.com, javascript:alert(1) http://evil.example",
      }),
    ).toEqual(["https://*.cerner.com", "https://fhir.epic.com"]);
    expect(
      frameAncestors({ SMART_ISS: "http://127.0.0.1:4010/fhir", SMART_CLIENT_ID: "x" }),
    ).toEqual(["http://127.0.0.1:4010"]);
    expect(frameAncestors({})).toEqual([]);
  });

  it("builds a nonce CSP with frame-ancestors, and HSTS only over HTTPS", () => {
    const csp = contentSecurityPolicy({
      nonce: "abc",
      dev: false,
      ancestors: ["https://fhir.epic.com"],
    });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic';");
    expect(csp).toContain("frame-ancestors 'self' https://fhir.epic.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe");
    expect(contentSecurityPolicy({ nonce: "abc", dev: true, ancestors: [] })).toContain(
      "'unsafe-eval'",
    );
    const h = securityHeaders({ csp, https: true });
    expect(h).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(securityHeaders({ csp, https: false })["strict-transport-security"]).toBeUndefined();
    expect(h).not.toHaveProperty("x-frame-options");
  });

  it("uses SameSite=None for the session cookie only when asked and only over HTTPS", () => {
    expect(sessionCookie("t", true, 1000, {})).toContain("SameSite=Lax");
    expect(sessionCookie("t", true, 1000, { SESSION_COOKIE_SAMESITE: "none" })).toContain(
      "SameSite=None; Max-Age=1; Secure",
    );
    expect(sessionCookie("t", false, 1000, { SESSION_COOKIE_SAMESITE: "none" })).toContain(
      "SameSite=Lax",
    );
  });
});
