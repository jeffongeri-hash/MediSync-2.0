// SMART launch orchestration, framework-free so tests drive it directly: start (EHR or standalone) -> authorization
// redirect; callback -> token, launch context, record read, ingest and mapping, audit. Errors carry a short code
// that is safe to show; nothing patient-identifying is logged or put in the audit details.
import type { Db } from "@/db";
import { recordAudit, type AuditEntry } from "@/audit";
import { ingestSource } from "@/ingest/ingest";
import { runMapping } from "@/mapping/run";
import { authorizeUrl, completeAuthorization } from "@/smart/adapter";
import { summarizeCapability, type CapabilitySummary } from "@/smart/capability";
import {
  allowedIss,
  launchScope,
  normalizeIss,
  sourceSystemFor,
  type LaunchKind,
  type SmartConfig,
} from "@/smart/config";
import {
  isFhirId,
  readPatientRecord,
  RecordReadError,
  type FhirGet,
  type QueryOutcome,
} from "@/smart/fetch";
import {
  createSession,
  findSession,
  sessionCookie,
  SessionStorage,
  type SmartSession,
} from "@/smart/session";

export class LaunchError extends Error {
  constructor(readonly code: string) {
    super(`SMART launch failed: ${code}`);
  }
}

/** Shown in the UI; anything else displays as a generic failure. */
export const LAUNCH_ERRORS: Record<string, string> = {
  config: "SMART launch is not configured on this server (see .env.example).",
  iss_not_allowed: "This FHIR server (iss) is not on the allowlist.",
  missing_launch: "An EHR launch needs a launch parameter.",
  discovery_failed: "Could not read the server's SMART configuration.",
  server_not_smart: "The server did not advertise an authorization endpoint.",
  no_session: "No launch in progress in this browser. Launch again.",
  denied: "The authorization server declined the request.",
  state_mismatch: "The authorization response does not belong to this launch. Launch again.",
  token_failed: "The code could not be exchanged for an access token.",
  no_patient: "The server returned no patient context.",
  read_failed: "The patient record could not be read.",
};

export const actorOf = (s: Pick<SmartSession, "fhirUser">) =>
  `smart:${s.fhirUser ?? "unknown-user"}`;

export async function beginLaunch(
  db: Db,
  cfg: SmartConfig,
  input: { kind: LaunchKind; iss?: string | null; launch?: string | null; secure: boolean },
): Promise<{ location: string; setCookie: string; sessionId: string }> {
  const iss = input.kind === "ehr" || input.iss ? allowedIss(cfg, input.iss) : cfg.issAllowlist[0]!;
  if (!iss) throw new LaunchError("iss_not_allowed");
  const launch = input.launch?.trim();
  if (input.kind === "ehr" && !launch) throw new LaunchError("missing_launch");
  if (launch && launch.length > 4096) throw new LaunchError("missing_launch");

  const { token, id } = await createSession(db, { launchType: input.kind, iss });
  const storage = new SessionStorage(db, id, cfg.sessionKey);
  // Only the validated values reach fhirclient: the URL it sees carries no query parameters.
  const here = new URL(cfg.redirectUri);
  here.search = "";
  let location: string;
  try {
    location = await authorizeUrl(here, storage, {
      clientId: cfg.clientId,
      scope: launchScope(input.kind, cfg.readScopes),
      redirectUri: cfg.redirectUri,
      iss,
      launch,
    });
  } catch {
    throw new LaunchError("discovery_failed");
  }
  // fhirclient skips authorization for an open server and redirects straight back; refuse that.
  if (location.startsWith(cfg.redirectUri)) throw new LaunchError("server_not_smart");
  return { location, setCookie: sessionCookie(token, input.secure), sessionId: id };
}

export type CompleteDeps = { now?: () => Date };

/** Handles the redirect back from the authorization server. Returns the session it completed. */
export async function completeLaunch(
  db: Db,
  cfg: SmartConfig,
  input: { url: URL; token: string | null | undefined },
  deps: CompleteDeps = {},
): Promise<SmartSession> {
  const session = await findSession(db, input.token, deps.now?.() ?? new Date());
  if (!session) throw new LaunchError("no_session");
  if (session.authorizedAt) return session;
  const authError = input.url.searchParams.get("error");
  if (authError) throw new LaunchError("denied");

  const url = new URL(cfg.redirectUri);
  url.search = "";
  for (const k of ["code", "state"]) {
    const v = input.url.searchParams.get(k);
    if (v) url.searchParams.set(k, v);
  }
  const storage = new SessionStorage(db, session.id, cfg.sessionKey);
  let client: Awaited<ReturnType<typeof completeAuthorization>>;
  try {
    client = await completeAuthorization(url, storage);
  } catch (e) {
    throw new LaunchError(
      /state/i.test(e instanceof Error ? e.message : "") ? "state_mismatch" : "token_failed",
    );
  }
  const state = client.state as {
    serverUrl?: string;
    scope?: string;
    tokenResponse?: Record<string, unknown>;
  };
  if (!state.tokenResponse?.access_token) throw new LaunchError("token_failed");
  if (normalizeIss(state.serverUrl ?? "") !== session.iss) throw new LaunchError("state_mismatch");

  const fhirPatientId = client.getPatientId();
  if (!fhirPatientId || !isFhirId(fhirPatientId)) throw new LaunchError("no_patient");
  const fhirUser = client.getFhirUser() ?? null;
  const encounterId = client.getEncounterId() ?? null;
  const grantedScope =
    typeof state.tokenResponse.scope === "string"
      ? state.tokenResponse.scope
      : (state.scope ?? null);
  const actor = actorOf({ fhirUser });
  const sourceSystem = sourceSystemFor(session.iss);

  const get: FhirGet = (u) =>
    client.request({ url: u, headers: { accept: "application/fhir+json" } });
  let record: Awaited<ReturnType<typeof readPatientRecord>>;
  try {
    record = await readPatientRecord(get, session.iss, fhirPatientId);
  } catch (e) {
    const queries = e instanceof RecordReadError ? e.queries : [];
    await db.smartSession.update({
      where: { id: session.id },
      data: { fhirUser, fhirPatientId, scope: grantedScope, fetchSummary: { queries } },
    });
    throw new LaunchError("read_failed");
  }
  let capability: CapabilitySummary | null = null;
  try {
    capability = summarizeCapability(await get("metadata"), session.iss);
  } catch {
    capability = null;
  }

  const ingest = await ingestSource(
    db,
    {
      format: "FHIR_BUNDLE",
      sourceSystem,
      filename: "smart-launch-read.json",
      bytes: record.bytes,
      contentType: "application/fhir+json",
      summary: {
        launchType: session.launchType,
        entries: record.bundle.entry.length,
        queries: record.queries.map(countsOnly),
      },
    },
    actor,
  );
  await runMapping(db, { actor });
  // The patient index row the read was attributed to. An unchanged chart is the same bytes, hence the same (already
  // ingested) source record, so look it up through the record rather than re-deriving it.
  const read = await db.sourceRecord.findUniqueOrThrow({
    where: { id: ingest.sourceRecordId },
    select: { patient: { select: { id: true, sourcePatientId: true } } },
  });
  const patient = read.patient;
  if (!patient || patient.sourcePatientId !== fhirPatientId) throw new LaunchError("read_failed");

  // The token was needed only for this read: drop it (and the PKCE state) instead of keeping a credential around.
  const done = await db.smartSession.update({
    where: { id: session.id },
    data: {
      stateEnc: null,
      authorizedAt: new Date(),
      scope: grantedScope,
      fhirUser,
      fhirPatientId,
      encounterId,
      patientId: patient.id,
      sourceRecordId: ingest.sourceRecordId,
      fetchSummary: { queries: record.queries, capability },
    },
  });

  const audit: AuditEntry[] = [
    {
      actor,
      action: "LOGIN",
      patientId: patient.id,
      entityType: "SmartSession",
      entityId: session.id,
      source: sourceSystem,
      details: {
        launchType: session.launchType,
        encounterContext: !!encounterId,
        scopes: grantedScope?.split(" ").length ?? 0,
      },
    },
    ...record.queries.map((q): AuditEntry => ({
      actor,
      action: "READ",
      patientId: patient.id,
      entityType: q.resourceType,
      entityId: null,
      source: sourceSystem,
      details: { query: q.label, ok: q.ok, count: q.count, pages: q.pages, error: q.error ?? null },
    })),
  ];
  await recordAudit(db, audit);
  return done;
}

const countsOnly = (q: QueryOutcome) => ({ label: q.label, ok: q.ok, count: q.count });
