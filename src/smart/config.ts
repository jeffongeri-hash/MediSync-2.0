// SMART on FHIR launch settings (Phase 5). Parsed only when a launch route runs, so the rest of the app needs none of
// them. Errors name the variables, never their values.
import { z } from "zod";

/** Resource types read at launch. Scopes and the record fetch both come from this list. */
export const READ_TYPES = [
  "Patient",
  "Condition",
  "MedicationRequest",
  "Medication",
  "AllergyIntolerance",
  "Encounter",
] as const;
export type ReadType = (typeof READ_TYPES)[number];

export type LaunchKind = "ehr" | "standalone";

/** SMART v1 read scopes, one per type (not patient/*.read). SMART_SCOPE replaces them. */
export const DEFAULT_READ_SCOPES = READ_TYPES.map((t) => `patient/${t}.read`).join(" ");

/** EHR launch asks for `launch` (context comes from the EHR); standalone asks the server to pick a patient. */
export function launchScope(kind: LaunchKind, readScopes: string): string {
  return [kind === "ehr" ? "launch" : "launch/patient", "openid", "fhirUser", readScopes].join(" ");
}

/** One registered EHR: its FHIR base (iss), the client id from that EHR's app registration, and the read scopes. */
export type SmartServer = { name: string; iss: string; clientId: string; readScopes: string };

export type SmartConfig = {
  /** In SMART_SERVERS order; the first is the standalone default. Each iss is normalized (no trailing slash). */
  servers: SmartServer[];
  /** Shared by every server (each registration lists the same redirect URI). */
  redirectUri: string;
  /** AES-256-GCM key for smart_sessions.state_enc. */
  sessionKey: Buffer;
};

/** Names the variables to set, never their values. */
export class SmartConfigError extends Error {
  constructor(readonly names: string[]) {
    super(
      `SMART launch is not configured: set ${[...new Set(names)].join(", ")} (see .env.example)`,
    );
  }
}

export const normalizeIss = (iss: string) => iss.trim().replace(/\/+$/, "");

const httpUrl = z.url({ protocol: /^https?$/ });
const SERVER_NAME = /^[a-z][a-z0-9-]{0,19}$/;

/** SMART_<NAME>_<FIELD> for a server name ("oracle" -> SMART_ORACLE_ISS). */
export const serverVar = (name: string, field: "ISS" | "CLIENT_ID" | "SCOPE") =>
  `SMART_${name.toUpperCase().replace(/-/g, "_")}_${field}`;

const scopes = (v: string | undefined) =>
  v?.trim() ? v.trim().split(/\s+/).join(" ") : DEFAULT_READ_SCOPES;

const fail = (names: string[]): never => {
  throw new SmartConfigError(names);
};

/**
 * The configured servers, without the session secret (so scripts can use it). Two forms:
 * named, `SMART_SERVERS=epic,oracle` with SMART_<NAME>_ISS, SMART_<NAME>_CLIENT_ID and optional SMART_<NAME>_SCOPE;
 * or single, SMART_ISS (comma list) + SMART_CLIENT_ID + SMART_SCOPE. SMART_SERVERS wins when set.
 */
export function smartServers(env: Record<string, string | undefined> = process.env): SmartServer[] {
  const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
  const missing: string[] = [];
  const iss = (name: string, v: string | undefined) => {
    const n = v ? normalizeIss(v) : "";
    if (!httpUrl.safeParse(n).success) missing.push(name);
    return n;
  };
  let servers: SmartServer[];
  const names = blank(env.SMART_SERVERS);
  if (names) {
    const list = names
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    if (
      !list.length ||
      list.some((n) => !SERVER_NAME.test(n)) ||
      new Set(list).size !== list.length
    )
      fail(["SMART_SERVERS (comma-separated distinct names: a-z, 0-9, -)"]);
    servers = list.map((name) => {
      const clientId = blank(env[serverVar(name, "CLIENT_ID")]);
      if (!clientId) missing.push(serverVar(name, "CLIENT_ID"));
      return {
        name,
        iss: iss(serverVar(name, "ISS"), blank(env[serverVar(name, "ISS")])),
        clientId: clientId ?? "",
        readScopes: scopes(env[serverVar(name, "SCOPE")]),
      };
    });
  } else {
    const clientId = blank(env.SMART_CLIENT_ID);
    if (!clientId) missing.push("SMART_CLIENT_ID");
    const list = (blank(env.SMART_ISS) ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!list.length) missing.push("SMART_ISS");
    servers = list.map((v, i) => ({
      name: i === 0 ? "default" : `default-${i + 1}`,
      iss: iss("SMART_ISS", v),
      clientId: clientId ?? "",
      readScopes: scopes(env.SMART_SCOPE),
    }));
  }
  if (missing.length) fail(missing);
  if (new Set(servers.map((s) => s.iss)).size !== servers.length)
    fail(["distinct ISS values (two servers share one iss)"]);
  return servers;
}

export function smartConfig(env: Record<string, string | undefined> = process.env): SmartConfig {
  const missing: string[] = [];
  let servers: SmartServer[] = [];
  try {
    servers = smartServers(env);
  } catch (e) {
    if (!(e instanceof SmartConfigError)) throw e;
    missing.push(...e.names);
  }
  const redirectUri = env.SMART_REDIRECT_URI?.trim() ?? "";
  if (!httpUrl.safeParse(redirectUri).success) missing.push("SMART_REDIRECT_URI");
  const key = Buffer.from(env.SESSION_SECRET?.trim() ?? "", "base64");
  if (key.length < 32) missing.push("SESSION_SECRET (32+ bytes, base64)");
  if (missing.length) fail(missing);
  return { servers, redirectUri, sessionKey: key.subarray(0, 32) };
}

/** The server whose iss equals `iss` (after normalization), else null. Prefix matches are not accepted. */
export function serverForIss(
  cfg: Pick<SmartConfig, "servers">,
  iss: string | null | undefined,
): SmartServer | null {
  if (!iss) return null;
  const n = normalizeIss(iss);
  return cfg.servers.find((s) => s.iss === n) ?? null;
}

export function serverByName(
  cfg: Pick<SmartConfig, "servers">,
  name: string | null | undefined,
): SmartServer | null {
  return name ? (cfg.servers.find((s) => s.name === name.trim().toLowerCase()) ?? null) : null;
}

/** Known public sandboxes. Hosts are from memory (unverified, docs/NOTES.md); anything else is smart:<host[:port]>. */
const SANDBOXES: Record<string, { source: string; label: string }> = {
  "fhir.epic.com": { source: "epic-sandbox", label: "Epic sandbox" },
  "fhir-ehr-code.cerner.com": { source: "oracle-sandbox", label: "Oracle Health sandbox" },
};

/** Source system for rows read from a SMART server: "epic-sandbox", "oracle-sandbox", else smart:<host[:port]>. */
export function sourceSystemFor(iss: string): string {
  const u = new URL(iss);
  return SANDBOXES[u.hostname]?.source ?? `smart:${u.host}`;
}

/** Human label for the launch banner: the sandbox's name, else the host. */
export function serverLabel(iss: string): string {
  const u = new URL(iss);
  return SANDBOXES[u.hostname]?.label ?? u.host;
}
