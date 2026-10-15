import { describe, expect, it } from "vitest";
import { authorizeRequest, authorizeToken } from "@/access";

const env = {
  MEDISYNC_REVIEWER_TOKEN: "reviewer-token",
  MEDISYNC_EXPORTER_TOKEN: "exporter-token",
  MEDISYNC_AUDITOR_TOKEN: "auditor-token",
};

function bearer(token: string): Request {
  return new Request("http://localhost/api/transfer", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("authorizeToken", () => {
  it("stays open when no tokens are configured", () => {
    expect(authorizeToken(undefined, "transfer.export", {})).toEqual({
      ok: true,
      role: "open",
      key: "open",
    });
  });

  it("fails closed once any token is set", () => {
    expect(authorizeToken(undefined, "transfer.dryRun", env)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorizeToken("nope", "transfer.dryRun", env)).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(authorizeToken("reviewer-token", "transfer.export", env)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(authorizeToken("auditor-token", "transfer.read", env)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("lets an exporter dry-run and export, and an auditor export the audit log", () => {
    expect(authorizeToken("exporter-token", "transfer.export", env).ok).toBe(true);
    expect(authorizeToken("exporter-token", "transfer.dryRun", env).ok).toBe(true);
    expect(authorizeToken("reviewer-token", "transfer.dryRun", env).ok).toBe(true);
    expect(authorizeToken("auditor-token", "audit.export", env).ok).toBe(true);
    expect(authorizeToken("exporter-token", "audit.export", env)).toMatchObject({ status: 403 });
  });

  it("does not use the token as the rate-limit key", () => {
    const grant = authorizeToken("exporter-token", "transfer.read", env);
    expect(grant.ok).toBe(true);
    if (grant.ok) expect(grant.key).not.toContain("exporter-token");
  });
});

describe("authorizeRequest", () => {
  it("reads a bearer token", () => {
    expect(authorizeRequest(bearer("reviewer-token"), "transfer.read", env).ok).toBe(true);
    expect(authorizeRequest(bearer("auditor-token"), "transfer.read", env)).toMatchObject({
      status: 403,
    });
  });

  it("reads the session cookie", () => {
    const request = new Request("http://localhost/api/transfer", {
      headers: { cookie: "other=1; medisync_session=exporter-token" },
    });
    expect(authorizeRequest(request, "transfer.export", env)).toMatchObject({
      ok: true,
      role: "exporter",
    });
  });
});
