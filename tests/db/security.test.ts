// Phase 6: roles and patient access on the real route handlers, with demo mode off (production default).
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { templateResponder } from "@/ai/responders";
import { recordAudit } from "@/audit";
import { verifyAuditLog, verifyChain, type AuditRow } from "@/audit/chain";
import { createDb } from "@/db";
import { resolvePatient } from "@/export/run";
import { seedSynthea } from "@/ingest/seed";
import { runMapping } from "@/mapping/run";
import { runReconciliation } from "@/reconcile/run";
import { sha256 } from "@/ingest/source-summary";
import { accessFor, DEMO_ACTOR } from "@/security/access";
import { dataKeys, keyIdOf, openText, rawTextAad } from "@/security/crypt";
import { rotateSealed } from "@/security/rotate";
import { hit, subjectOf } from "@/security/ratelimit";
import { grantRole, revokeRole, roleOf } from "@/security/roles";
import { createSession, SESSION_COOKIE } from "@/smart/session";
import { POST as transferPost } from "../../app/api/transfer/route";
import { GET as transferGet } from "../../app/api/transfer/[id]/route";
import { GET as writebackGet } from "../../app/smart/writeback/[runId]/route";
import { GET as auditGet } from "../../app/api/admin/audit/route";

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
    await db.rateLimit.deleteMany({ where: { key: { startsWith: "test-" } } });
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

  it("chains every audit entry, including rows written together and concurrently", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordAudit(db, [
          { actor: "test:chain", action: "READ", entityType: "Test", entityId: `c${i}a` },
          { actor: "test:chain", action: "READ", entityType: "Test", entityId: `c${i}b` },
        ]),
      ),
    );
    expect(await verifyAuditLog(db)).toMatchObject({ verified: true, broken: null });
  });

  it("detects an edited or a deleted audit row (tampered in a rolled-back transaction)", async () => {
    class Rollback extends Error {}
    const [r1, r2, r3] = await db.auditLog.findMany({
      orderBy: { id: "asc" },
      take: 3,
      select: { id: true },
    });
    const found: unknown[] = [];
    for (const sql of [
      `UPDATE audit_log SET actor = 'smart:forged' WHERE id = ${r1!.id}`,
      `DELETE FROM audit_log WHERE id = ${r2!.id}`,
    ]) {
      await expect(
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              "ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete",
            );
            await tx.$executeRawUnsafe(sql);
            found.push((await verifyAuditLog(tx)).broken);
            throw new Rollback();
          },
          { timeout: 60_000 },
        ),
      ).rejects.toBeInstanceOf(Rollback);
    }
    expect(found).toEqual([
      { id: String(r1!.id), reason: "hash" },
      { id: String(r3!.id), reason: "prev_hash" },
    ]);
    expect((await verifyAuditLog(db)).verified).toBe(true);
  });

  it("exports the audit log to admins only, verified, and audits the export", async () => {
    const get = (token?: string, q = "") => auditGet(req(`/api/admin/audit${q}`, token));
    expect((await get()).status).toBe(401);
    expect((await get(await session(PRACTITIONER, a))).status).toBe(403);
    const admin = `${ISS}/Practitioner/sec-admin`;
    await grantRole(db, { actor: `smart:${admin}`, role: "ADMIN", by: "test:security" });
    const token = await session(admin, a);
    expect((await get(token, "?from=yesterday")).status).toBe(400);
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const res = await get(token, `?from=${encodeURIComponent(from)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-audit-chain")).toBe("verified");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditRow & { chain?: { verified: boolean } });
    expect(lines.at(-1)!.chain).toMatchObject({ verified: true, broken: null });
    const rows = lines.slice(0, -1);
    expect(rows.some((r) => r.entityType === "UserRole" && r.entityId === `smart:${admin}`)).toBe(
      true,
    );
    expect(verifyChain(rows, rows[0]?.prevHash ?? null).verified).toBe(true);
    const logged = await db.auditLog.findFirst({
      where: { actor: `smart:${admin}`, action: "EXPORT", entityType: "AuditLog" },
      orderBy: { id: "desc" },
    });
    expect(logged?.details).toMatchObject({ verified: true, from });
  });

  it("counts requests per fixed window and says when to retry", async () => {
    const rule = { name: `test-${Date.now()}`, limit: 2, windowSec: 60 };
    const at = new Date("2026-10-15T12:00:10.000Z");
    expect(await hit(db, rule, "s:one", at)).toBeNull();
    expect(await hit(db, rule, "s:one", at)).toBeNull();
    expect(await hit(db, rule, "s:one", at)).toBe(50);
    expect(await hit(db, rule, "s:two", at)).toBeNull();
    expect(await hit(db, rule, "s:one", new Date("2026-10-15T12:01:00.000Z"))).toBeNull();
  });

  it("keys by session, else by a hashed client IP only behind a trusted proxy", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(subjectOf({ id: "a".repeat(64) }, h, { TRUST_PROXY: "1" })).toBe(`s:${"a".repeat(32)}`);
    const ip = subjectOf(null, h, { TRUST_PROXY: "1" });
    expect(ip).toMatch(/^ip:[0-9a-f]{32}$/);
    expect(ip).not.toContain("203.0");
    expect(subjectOf(null, h, {})).toBe("ip:unknown");
  });

  it("answers 429 with Retry-After once a route's limit is spent", async () => {
    const { token } = await createSession(db, { launchType: "ehr", iss: ISS });
    const get = () => auditGet(req("/api/admin/audit", token));
    for (let i = 0; i < 5; i++) expect((await get()).status).toBe(401);
    const res = await get();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "too many requests" });
  });
});
