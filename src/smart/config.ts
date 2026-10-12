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

export type SmartConfig = {
  clientId: string;
  /** Normalized (no trailing slash). The first one is the standalone default. */
  issAllowlist: string[];
  redirectUri: string;
  readScopes: string;
  /** AES-256-GCM key for smart_sessions.state_enc. */
  sessionKey: Buffer;
};

export class SmartConfigError extends Error {}

export const normalizeIss = (iss: string) => iss.trim().replace(/\/+$/, "");

const httpUrl = z.url({ protocol: /^https?$/ });

const schema = z.object({
  SMART_CLIENT_ID: z.string().trim().min(1),
  SMART_ISS: z
    .string()
    .transform((v) => v.split(",").map(normalizeIss).filter(Boolean))
    .pipe(z.array(httpUrl).min(1)),
  SMART_REDIRECT_URI: httpUrl,
  SMART_SCOPE: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim().split(/\s+/).join(" ") : DEFAULT_READ_SCOPES)),
  SESSION_SECRET: z
    .string()
    .transform((v) => Buffer.from(v, "base64"))
    .refine((b) => b.length >= 32, "must decode to at least 32 bytes"),
});

export function smartConfig(env: Record<string, string | undefined> = process.env): SmartConfig {
  const blank = (v: string | undefined) => (v?.trim() ? v : undefined);
  const r = schema.safeParse({
    SMART_CLIENT_ID: blank(env.SMART_CLIENT_ID),
    SMART_ISS: blank(env.SMART_ISS),
    SMART_REDIRECT_URI: blank(env.SMART_REDIRECT_URI),
    SMART_SCOPE: env.SMART_SCOPE,
    SESSION_SECRET: blank(env.SESSION_SECRET),
  });
  if (!r.success) {
    const names = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
    throw new SmartConfigError(
      `SMART launch is not configured: set ${names.join(", ")} (see .env.example)`,
    );
  }
  const e = r.data;
  return {
    clientId: e.SMART_CLIENT_ID,
    issAllowlist: e.SMART_ISS,
    redirectUri: e.SMART_REDIRECT_URI,
    readScopes: e.SMART_SCOPE,
    sessionKey: e.SESSION_SECRET.subarray(0, 32),
  };
}

/** The allowlisted entry equal to `iss` (after normalization), else null. Prefix matches are not accepted. */
export function allowedIss(cfg: SmartConfig, iss: string | null | undefined): string | null {
  if (!iss) return null;
  const n = normalizeIss(iss);
  return cfg.issAllowlist.find((a) => a === n) ?? null;
}

/** Source system for rows read from a SMART server: "epic-sandbox" for Epic's sandbox host, else smart:<host[:port]>. */
export function sourceSystemFor(iss: string): string {
  const u = new URL(iss);
  return u.hostname === "fhir.epic.com" ? "epic-sandbox" : `smart:${u.host}`;
}
