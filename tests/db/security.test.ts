// Phase 6: roles and patient access on the real route handlers, with demo mode off (production default).
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateResponder } from "@/ai/responders";
import { createDb } from "@/db";
import { resolvePatient } from "@/export/run";
import { seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";
import { runReconciliation } from "@/reconcile/run";
import { sha256 } from "@/ingest/source-summary";
import { accessFor, DEMO_ACTOR } from "@/security/access";
import { dataKeys, keyIdOf, openText, rawTextAad } from "@/security/crypt";
import { rotateSealed } from "@/security/rotate";
import { grantRole, revokeRole, roleOf } from "@/security/roles";
import { createSession, SESSION_COOKIE } from "@/smart/session";
import { POST as transferPost } from "../../app/api/transfer/route";
import { GET as transferGet } from "../../app/api/transfer/[id]/route";
import { GET as writebackGet } from "../../app/smart/writeback/[runId]/route";

const ISS = "https://security-test.invalid/fhir";
const PRACTITIONER = `${ISS}/Practitioner/sec-1`;
const PATIENT_USER = `${ISS}/Patient/sec-2`;
const SOURCE_A = "c4a5ef89-933c-c428-8fa7-4a26d9f621a9";

describe.skipIf(!process.env.DATABASE_URL)("roles and access (database)", () => {
  const db = createDb();
  const demo = process.env.DEMO_MODE;
  let a: string;
  let b: string;
  let runId: string;

  const session = async (fhirUser: string | null, patientId: string) => {
    const { token, id } = await createSession(db, { launchType: "ehr", iss: ISS });
    await db.smartSession.update({
      where: { id },
      data: { authorizedAt: new Date(), fhirUser, patientId },
    });
    return token;
  };
  const req = (path: string, token?: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const post = (token: string | undefined, patient: string) =>
    transferPost(req("/api/transfer", token, { patient, dryRun: true }));
  const getJob = (token: string | undefined, id: string) =>
    transferGet(req(`/api/transfer/${id}`, token), { params: Promise.resolve({ id }) });
  const cleanup = async () => {
    await db.smartSession.deleteMany({ where: { iss: ISS } });
    await db.userRole.deleteMany({ where: { actor: { startsWith: `smart:${ISS}` } } });
    await db.sourceRecord.deleteMany({ where: { sourceSystem: "test-rotate" } });
  };

  beforeAll(async () => {
    process.env.DEMO_MODE = "0";
    await cleanup();
    await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
    await runMapping(db, { actor: "test:security" });
    a = await resolvePatient(db, SOURCE_A);
    const other = await db.patient.findFirstOrThrow({
      where: { id: { not: a }, sourceSystem: "synthea" },
      select: { id: true },
    });
    b = other.id;
    ({ runId } = await runReconciliation(db, {
      patientId: a,
      actor: "test:security",
      responder: templateResponder(),
    }));
  });

  afterAll(async () => {
    process.env.DEMO_MODE = demo;
    // An undefined id would match every row.
    if (runId) {
      const runs = { id: runId };
      await db.reconciliationClaim.deleteMany({ where: { run: runs } });
      await db.reconciliationItem.deleteMany({ where: { run: runs } });
      await db.reconciliationRun.deleteMany({ where: runs });
    }
    await db.transferJob.deleteMany({ where: { requestedBy: { startsWith: `smart:${ISS}` } } });
    await cleanup();
    await db.$disconnect();
  });

  it("closes the seeded patients without demo mode and opens them to the demo provider with it", async () => {
    const seeded = { id: a, sourceSystem: "synthea" };
    expect(await accessFor(db, null, seeded, { DEMO_MODE: "0" })).toBeNull();
    expect(await accessFor(db, null, seeded, { DEMO_MODE: "1" })).toMatchObject({
      actor: DEMO_ACTOR,
      role: "PROVIDER",
    });
  });

  it("opens a launched patient only from its own session, with the user's role", async () => {
    const token = await session(PRACTITIONER, a);
    const s = await db.smartSession.findFirstOrThrow({ where: { iss: ISS, patientId: a } });
    expect(await accessFor(db, s, { id: a, sourceSystem: "synthea" }, {})).toMatchObject({
      actor: `smart:${PRACTITIONER}`,
      role: "PROVIDER",
    });
    expect(
      await accessFor(db, s, { id: b, sourceSystem: "synthea" }, { DEMO_MODE: "0" }),
    ).toBeNull();
    expect(token).toBeTruthy();
  });

  it("audits grants and revokes, and a grant overrides the default role", async () => {
    const actor = `smart:${PATIENT_USER}`;
    expect(await roleOf(db, { actor, fhirUser: PATIENT_USER })).toBe("VIEWER");
    await grantRole(db, { actor, role: "ADMIN", by: "test:security" });
    expect(await roleOf(db, { actor, fhirUser: PATIENT_USER })).toBe("ADMIN");
    expect(await revokeRole(db, { actor, by: "test:security" })).toBe(true);
    expect(await revokeRole(db, { actor, by: "test:security" })).toBe(false);
    expect(await roleOf(db, { actor, fhirUser: PATIENT_USER })).toBe("VIEWER");
    const audit = await db.auditLog.findMany({
      where: { entityType: "UserRole", entityId: actor },
      orderBy: { id: "desc" },
      take: 2,
    });
    expect(audit.map((e) => e.action)).toEqual(["DELETE", "UPDATE"]);
    await expect(
      grantRole(db, { actor: "demo:provider", role: "ADMIN", by: "x" }),
    ).rejects.toThrow();
  });

  it("enforces role and patient on POST /api/transfer", async () => {
    expect((await post(undefined, SOURCE_A)).status).toBe(401);
    const viewer = await session(PATIENT_USER, a);
    expect((await post(viewer, SOURCE_A)).status).toBe(403);
    const provider = await session(PRACTITIONER, a);
    const ok = await post(provider, SOURCE_A);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { dryRun: boolean }).dryRun).toBe(true);
    const otherPatient = await db.patient.findUniqueOrThrow({
      where: { id: b },
      select: { sourcePatientId: true },
    });
    expect((await post(provider, otherPatient.sourcePatientId)).status).toBe(404);
  });

  it("lets any role read its own patient's job on GET /api/transfer/:id, and nothing else", async () => {
    const provider = await session(PRACTITIONER, a);
    const job = (await (await post(provider, SOURCE_A)).json()) as { id: string };
    expect((await getJob(undefined, job.id)).status).toBe(401);
    expect((await getJob(await session(PATIENT_USER, a), job.id)).status).toBe(200);
    expect((await getJob(await session(PRACTITIONER, b), job.id)).status).toBe(404);
  });

  it("lets only a provider download the write-back package", async () => {
    const get = (token: string) =>
      writebackGet(req(`/smart/writeback/${runId}`, token), {
        params: Promise.resolve({ runId }),
      });
    expect((await get(await session(PATIENT_USER, a))).status).toBe(403);
    expect((await get(await session(PRACTITIONER, a))).status).toBe(200);
    expect((await get(await session(PRACTITIONER, b))).status).toBe(404);
  });

  it.skipIf(!dataKeys())(
    "seals plaintext rows with crypt:rotate and leaves sealed rows alone",
    async () => {
      const text = `{"resourceType":"Bundle","id":"rotate-${Date.now()}","type":"collection"}`;
      const row = await db.sourceRecord.create({
        data: {
          format: "FHIR_BUNDLE",
          sourceSystem: "test-rotate",
          filename: "rotate.json",
          contentType: "application/fhir+json",
          rawText: text,
          sha256: sha256(text),
          byteSize: Buffer.byteLength(text),
        },
        select: { id: true, sha256: true },
      });
      expect((await rotateSealed(db)).sourceRecords).toBeGreaterThanOrEqual(1);
      const stored = await db.sourceRecord.findUniqueOrThrow({
        where: { id: row.id },
        select: { rawText: true },
      });
      expect(keyIdOf(stored.rawText)).toBe(dataKeys()!.current);
      expect(stored.rawText).not.toContain("rotate-");
      expect(openText(stored.rawText, rawTextAad(row.sha256))).toBe(text);
      expect((await rotateSealed(db)).sourceRecords).toBe(0);
    },
  );
});
