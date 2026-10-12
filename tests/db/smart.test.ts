import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateResponder } from "@/ai/responders";
import { createDb } from "@/db";
import { SYNTHEA_SOURCE, seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";
import { runReconciliation } from "@/reconcile/run";
import { smartConfig, type SmartConfig } from "@/smart/config";
import { beginLaunch, completeLaunch, LaunchError } from "@/smart/launch";
import { SESSION_COOKIE } from "@/smart/session";
import { MOCK_PRACTITIONER, mockId, startMockSmart, type MockSmart } from "../mock-smart/server";

// Phase 5: EHR and standalone SMART launches against the test-only mock server (synthetic Synthea data), through
// fhirclient's real authorize/ready code: PKCE, state, token exchange, launch context, record read, ingest, audit.
const FIXTURES = join(process.cwd(), "fixtures/synthea/fhir");
const GONZALO = "c4a5ef89-933c-c428-8fa7-4a26d9f621a9";
const ERIK = "a90ab4e3-5a52-2884-aadc-32cd5ec6357d";
const APP = "http://localhost:3999";
const BUNDLES = [`Gonzalo160_Hermiston71_${GONZALO}.json`, `Erik495_Hermiston71_${ERIK}.json`].map(
  (f) => join(FIXTURES, f),
);

const cookieToken = (setCookie: string) =>
  new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(setCookie)![1]!;

/** Follows the authorization redirect the way a browser would and returns the callback URL. */
async function authorizeAt(location: string): Promise<URL> {
  const res = await fetch(location, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

describe.skipIf(!process.env.DATABASE_URL)("SMART launch (database + mock server)", () => {
  const db = createDb();
  let mock: MockSmart;
  let cfg: SmartConfig;

  const launchToken = async (patient = mockId(GONZALO)) => {
    const res = await fetch(mock.ehrLaunchUrl(`${APP}/smart/launch`, patient), {
      redirect: "manual",
    });
    const to = new URL(res.headers.get("location")!);
    return { iss: to.searchParams.get("iss")!, launch: to.searchParams.get("launch")! };
  };
  const ehrLaunch = async (patient = mockId(GONZALO)) => {
    const { iss, launch } = await launchToken(patient);
    const begun = await beginLaunch(db, cfg, { kind: "ehr", iss, launch, secure: false });
    const callback = await authorizeAt(begun.location);
    return { begun, callback, token: cookieToken(begun.setCookie) };
  };

  // Removes what this file creates (mock servers on 4011-4013), so other suites still see only seeded patients.
  const cleanup = async () => {
    const ports = [4011, 4012, 4013];
    const sourceSystem = { in: ports.map((p) => `smart:127.0.0.1:${p}`) };
    const patients = (
      await db.patient.findMany({ where: { sourceSystem }, select: { id: true } })
    ).map((p) => p.id);
    const runs = { patientId: { in: patients } };
    await db.reconciliationClaim.deleteMany({ where: { run: runs } });
    await db.reconciliationItem.deleteMany({ where: { run: runs } });
    await db.reconciliationRun.deleteMany({ where: runs });
    await db.smartSession.deleteMany({
      where: { iss: { in: ports.map((p) => `http://127.0.0.1:${p}/fhir`) } },
    });
    const records = { sourceRecord: { sourceSystem } };
    await db.mappingIssue.deleteMany({ where: records });
    await db.canonicalResource.deleteMany({ where: records });
    await db.sourceRecord.deleteMany({ where: { sourceSystem } });
    await db.patient.deleteMany({ where: { sourceSystem } });
  };

  beforeAll(async () => {
    await cleanup();
    await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
    await runMapping(db, { actor: "test:smart" });
    mock = await startMockSmart({
      port: 4011,
      clientId: "test-client",
      redirectUris: [`${APP}/smart/callback`],
      bundles: BUNDLES,
      pageSize: 5,
    });
    cfg = smartConfig({
      SMART_CLIENT_ID: "test-client",
      SMART_ISS: `${mock.iss}/`,
      SMART_REDIRECT_URI: `${APP}/smart/callback`,
      SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
    });
  }, 180_000);
  afterAll(async () => {
    await mock?.close();
    await cleanup();
    await db.$disconnect();
  });

  it("EHR launch: PKCE authorize, token, patient + encounter context, paged read, ingest, audit, tokens dropped", async () => {
    const { begun, callback, token } = await ehrLaunch();
    const auth = new URL(begun.location);
    expect(auth.origin + auth.pathname).toBe(`${mock.base}/oauth2/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("aud")).toBe(mock.iss);
    expect(auth.searchParams.get("scope")).toBe(
      "launch openid fhirUser patient/Patient.read patient/Condition.read patient/MedicationRequest.read patient/Medication.read patient/AllergyIntolerance.read patient/Encounter.read",
    );
    expect(begun.setCookie).toMatch(/HttpOnly; SameSite=Lax/);

    const pending = await db.smartSession.findUniqueOrThrow({ where: { id: begun.sessionId } });
    expect(pending.stateEnc).toMatch(/^v1\./);
    expect(pending.stateEnc).not.toMatch(/codeVerifier|clientId/);

    const s = await completeLaunch(db, cfg, { url: callback, token });
    expect(s).toMatchObject({
      launchType: "ehr",
      fhirPatientId: mockId(GONZALO),
      fhirUser: MOCK_PRACTITIONER,
      stateEnc: null,
    });
    expect(s.encounterId).toBeTruthy();
    expect(s.scope).toContain("patient/Condition.read");

    const rows = await db.canonicalResource.groupBy({
      by: ["resourceType"],
      where: { sourceRecordId: s.sourceRecordId! },
      _count: true,
    });
    expect(Object.fromEntries(rows.map((r) => [r.resourceType, r._count]))).toEqual({
      Patient: 1,
      Condition: 20,
      MedicationRequest: 12,
      Medication: 3,
      AllergyIntolerance: 6,
      Encounter: 16,
    });
    const patient = await db.patient.findUniqueOrThrow({ where: { id: s.patientId! } });
    expect(patient).toMatchObject({
      sourceSystem: "smart:127.0.0.1:4011",
      sourcePatientId: mockId(GONZALO),
    });
    // Paging was followed (page size 5), and every FHIR call carried the bearer token.
    expect(mock.requests.filter((r) => r.path === "/fhir/Condition").length).toBeGreaterThan(3);
    expect(
      mock.requests
        .filter(
          (r) =>
            r.path.startsWith("/fhir/") &&
            r.path !== "/fhir/metadata" &&
            !r.path.includes(".well-known"),
        )
        .every((r) => r.auth),
    ).toBe(true);

    const audit = await db.auditLog.findMany({
      where: { patientId: s.patientId!, actor: `smart:${MOCK_PRACTITIONER}` },
      orderBy: { id: "asc" },
    });
    expect(audit.some((a) => a.action === "LOGIN" && a.entityId === s.id)).toBe(true);
    const reads = audit
      .filter((a) => a.action === "READ")
      .map((a) => (a.details as { query: string }).query);
    expect(reads).toEqual(
      expect.arrayContaining([
        "Patient",
        "Condition:encounter-diagnosis",
        "MedicationRequest",
        "Medication",
        "Encounter",
      ]),
    );
    expect(JSON.stringify(audit.map((a) => a.details))).not.toContain(GONZALO);

    const fetch = s.fetchSummary as { capability: { software: string } };
    expect(fetch.capability.software).toBe("MediSync mock SMART server test");

    // The callback again (a reload) is a no-op; a second launch with an unchanged chart reuses the source record.
    expect((await completeLaunch(db, cfg, { url: callback, token })).id).toBe(s.id);
    const again = await ehrLaunch();
    expect(
      (await completeLaunch(db, cfg, { url: again.callback, token: again.token })).sourceRecordId,
    ).toBe(s.sourceRecordId);
  }, 60_000);

  it("standalone launch: launch/patient scope, server-picked patient, no encounter", async () => {
    const begun = await beginLaunch(db, cfg, { kind: "standalone", secure: true });
    const auth = new URL(begun.location);
    expect(auth.searchParams.get("launch")).toBeNull();
    expect(auth.searchParams.get("scope")).toMatch(/^launch\/patient openid fhirUser /);
    expect(begun.setCookie).toMatch(/; Secure$/);
    const s = await completeLaunch(db, cfg, {
      url: await authorizeAt(begun.location),
      token: cookieToken(begun.setCookie),
    });
    expect(s).toMatchObject({
      launchType: "standalone",
      fhirPatientId: mockId(GONZALO),
      encounterId: null,
    });
  }, 60_000);

  it("refuses an unlisted iss, a missing launch, a denial, and a callback from another browser's launch", async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof LaunchError ? e.code : String(e)),
      );
    expect(
      await code(
        beginLaunch(db, cfg, { kind: "ehr", iss: `${mock.iss}-evil`, launch: "x", secure: false }),
      ),
    ).toBe("iss_not_allowed");
    expect(
      await code(beginLaunch(db, cfg, { kind: "ehr", iss: mock.iss, launch: "", secure: false })),
    ).toBe("missing_launch");

    mock.denyNext();
    const denied = await ehrLaunch();
    expect(denied.callback.searchParams.get("error")).toBe("access_denied");
    expect(await code(completeLaunch(db, cfg, { url: denied.callback, token: denied.token }))).toBe(
      "denied",
    );

    const a = await ehrLaunch();
    const b = await ehrLaunch();
    expect(await code(completeLaunch(db, cfg, { url: a.callback, token: b.token }))).toBe(
      "state_mismatch",
    );
    expect(await code(completeLaunch(db, cfg, { url: a.callback, token: "not-a-session" }))).toBe(
      "no_session",
    );
    // A tampered sealed state fails closed.
    await db.smartSession.update({
      where: { id: a.begun.sessionId },
      data: { stateEnc: "v1.AAAA.BBBB.CCCC" },
    });
    expect(await code(completeLaunch(db, cfg, { url: a.callback, token: a.token }))).toBe(
      "token_failed",
    );
  }, 60_000);

  it("a failed search is reported and the rest of the record still loads", async () => {
    const failing = await startMockSmart({
      port: 4012,
      clientId: "test-client",
      redirectUris: [`${APP}/smart/callback`],
      bundles: BUNDLES,
      failTypes: ["Encounter"],
    });
    try {
      const c2 = { ...cfg, servers: [{ ...cfg.servers[0]!, iss: failing.iss }] };
      const res = await fetch(failing.ehrLaunchUrl(`${APP}/smart/launch`, mockId(ERIK)), {
        redirect: "manual",
      });
      const to = new URL(res.headers.get("location")!);
      const begun = await beginLaunch(db, c2, {
        kind: "ehr",
        iss: to.searchParams.get("iss"),
        launch: to.searchParams.get("launch"),
        secure: false,
      });
      const s = await completeLaunch(db, c2, {
        url: await authorizeAt(begun.location),
        token: cookieToken(begun.setCookie),
      });
      const queries = (
        s.fetchSummary as { queries: { label: string; ok: boolean; error?: string }[] }
      ).queries;
      expect(queries.find((q) => q.label === "Encounter")).toMatchObject({
        ok: false,
        error: "http_500",
      });
      expect(queries.find((q) => q.label === "MedicationRequest")).toMatchObject({ ok: true });
      expect(s.fhirPatientId).toBe(mockId(ERIK));
    } finally {
      await failing.close();
    }
  }, 60_000);

  it("two EHRs (named servers): each launch goes to its own server with its own client id", async () => {
    const other = await startMockSmart({
      port: 4013,
      clientId: "oracle-client",
      redirectUris: [`${APP}/smart/callback`],
      bundles: [BUNDLES[1]!],
    });
    const named = (oracleClientId: string) =>
      smartConfig({
        SMART_SERVERS: "epic,oracle",
        SMART_EPIC_ISS: mock.iss,
        SMART_EPIC_CLIENT_ID: "test-client",
        SMART_ORACLE_ISS: other.iss,
        SMART_ORACLE_CLIENT_ID: oracleClientId,
        SMART_REDIRECT_URI: `${APP}/smart/callback`,
        SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
      });
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof LaunchError ? e.code : String(e)),
      );
    try {
      const c2 = named("oracle-client");
      // EHR launch from the second server: routed by its iss, authorized with its client id.
      const res = await fetch(other.ehrLaunchUrl(`${APP}/smart/launch`), { redirect: "manual" });
      const to = new URL(res.headers.get("location")!);
      const begun = await beginLaunch(db, c2, {
        kind: "ehr",
        iss: to.searchParams.get("iss"),
        launch: to.searchParams.get("launch"),
        secure: false,
      });
      const auth = new URL(begun.location);
      expect(auth.origin).toBe(other.base);
      expect(auth.searchParams.get("client_id")).toBe("oracle-client");
      const s = await completeLaunch(db, c2, {
        url: await authorizeAt(begun.location),
        token: cookieToken(begun.setCookie),
      });
      expect(s).toMatchObject({ iss: other.iss, fhirPatientId: mockId(ERIK) });
      const patient = await db.patient.findUniqueOrThrow({ where: { id: s.patientId! } });
      expect(patient.sourceSystem).toBe("smart:127.0.0.1:4013");

      // Standalone launch picks the server by name.
      const epic = new URL(
        (await beginLaunch(db, c2, { kind: "standalone", server: "epic", secure: false })).location,
      );
      expect([epic.origin, epic.searchParams.get("client_id")]).toEqual([mock.base, "test-client"]);
      const oracle = new URL(
        (await beginLaunch(db, c2, { kind: "standalone", server: "oracle", secure: false }))
          .location,
      );
      expect([oracle.origin, oracle.searchParams.get("client_id")]).toEqual([
        other.base,
        "oracle-client",
      ]);
      expect(
        await code(beginLaunch(db, c2, { kind: "standalone", server: "cerner", secure: false })),
      ).toBe("unknown_server");

      // The other registration's client id is refused by the server.
      const wrong = await beginLaunch(db, named("test-client"), {
        kind: "standalone",
        server: "oracle",
        secure: false,
      });
      expect((await fetch(wrong.location, { redirect: "manual" })).status).toBe(400);
    } finally {
      await other.close();
    }
  }, 60_000);

  it("reconciles the launched chart (current) against a chosen synthetic C-CDA (incoming)", async () => {
    const { callback, token } = await ehrLaunch();
    const s = await completeLaunch(db, cfg, { url: callback, token });
    const outside = await db.patient.findUniqueOrThrow({
      where: {
        sourceSystem_sourcePatientId: { sourceSystem: SYNTHEA_SOURCE, sourcePatientId: GONZALO },
      },
    });
    const { runId } = await runReconciliation(db, {
      patientId: s.patientId!,
      actor: `smart:${s.fhirUser}`,
      responder: templateResponder(),
      scope: { currentSourceRecordId: s.sourceRecordId!, incomingPatientId: outside.id },
    });
    const run = await db.reconciliationRun.findUniqueOrThrow({
      where: { id: runId },
      include: { items: true },
    });
    expect(run).toMatchObject({
      patientId: s.patientId,
      incomingPatientId: outside.id,
      currentSourceRecordId: s.sourceRecordId,
    });
    const summary = run.summary as { rowsCurrent: number; rowsIncoming: number };
    expect(summary.rowsCurrent).toBeGreaterThan(0);
    expect(summary.rowsIncoming).toBeGreaterThan(0);
    // The same synthetic person on both sides: incoming rows pair with the launched chart by code and day.
    expect(run.items.filter((i) => i.currentId && i.incomingId).length).toBeGreaterThan(0);
    const currentIds = new Set(
      (
        await db.canonicalResource.findMany({
          where: { sourceRecordId: s.sourceRecordId! },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    expect(run.items.every((i) => !i.currentId || currentIds.has(i.currentId))).toBe(true);
  }, 60_000);
});
