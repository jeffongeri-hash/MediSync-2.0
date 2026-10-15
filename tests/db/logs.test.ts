// Phase 6 gate: no PHI in application logs. Runs the pipeline and the API (including its error paths) with every log
// line and console call captured, then looks for any seeded patient's names, birth date or ids in the output.
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { templateResponder } from "@/ai/responders";
import { createDb } from "@/db";
import { resolvePatient, runTransfer } from "@/export/run";
import { seedSynthea, SYNTHEA_SOURCE } from "@/ingest/seed";
import { setLogSink } from "@/log";
import { runMapping } from "@/mapping/run";
import { runReconciliation } from "@/reconcile/run";
import { POST as transferPost } from "../../app/api/transfer/route";
import { GET as transferGet } from "../../app/api/transfer/[id]/route";
import { launchRoute } from "@/smart/next";

describe.skipIf(!process.env.DATABASE_URL)("no PHI in logs (database)", () => {
  const db = createDb();
  const output: string[] = [];
  let restoreSink: () => void;
  const spies: { mockRestore(): void }[] = [];

  beforeAll(() => {
    restoreSink = setLogSink((line) => output.push(line));
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      spies.push(
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          output.push(
            args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
          );
        }),
      );
  });

  afterAll(async () => {
    spies.forEach((s) => s.mockRestore());
    restoreSink();
    await db.$disconnect();
  });

  it("logs nothing that identifies a patient across ingest, mapping, transfer, reconcile and the API", async () => {
    await seedSynthea(db, join(process.cwd(), "fixtures/synthea"));
    await runMapping(db, { actor: "test:logs" });
    const patients = await db.patient.findMany({
      where: { sourceSystem: SYNTHEA_SOURCE },
      select: { id: true, sourcePatientId: true, displayName: true },
    });
    const patientId = await resolvePatient(db, patients[0]!.sourcePatientId);
    await runTransfer(db, { patientId, actor: "test:logs", dryRun: true });
    await runReconciliation(db, { patientId, actor: "test:logs", responder: templateResponder() });

    const post = (body: unknown) =>
      transferPost(
        new NextRequest("http://localhost/api/transfer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const ok = (await (await post({ patient: patients[1]!.sourcePatientId })).json()) as {
      id: string;
    };
    await post({ patient: "no-such-patient" });
    await post({ patient: patients[2]!.displayName, dryRun: "yes" });
    await transferGet(new NextRequest(`http://localhost/api/transfer/${ok.id}`), {
      params: Promise.resolve({ id: ok.id }),
    });
    // A launch from an iss that is not configured fails and logs its class only.
    await launchRoute(
      new NextRequest(
        `http://localhost/smart/launch?iss=${encodeURIComponent("https://ehr.invalid/fhir")}&launch=${patients[0]!.sourcePatientId}`,
      ),
      "ehr",
    );

    const resources = await db.canonicalResource.findMany({
      where: { resourceType: "Patient", patientId: { in: patients.map((p) => p.id) } },
      select: { resource: true },
    });
    const secrets = new Set<string>();
    for (const p of patients) {
      secrets.add(p.id);
      secrets.add(p.sourcePatientId);
      for (const part of (p.displayName ?? "").split(/\s+/)) if (part.length > 3) secrets.add(part);
    }
    for (const r of resources) {
      const res = r.resource as {
        birthDate?: string;
        name?: { family?: string; given?: string[] }[];
      };
      if (res.birthDate) secrets.add(res.birthDate);
      for (const n of res.name ?? [])
        [n.family, ...(n.given ?? [])].forEach((v) => v && secrets.add(v));
    }
    expect(secrets.size).toBeGreaterThan(30);
    const text = output.join("\n");
    const leaked = [...secrets].filter((s) => text.includes(s));
    expect(leaked).toEqual([]);
    // Synthea's synthetic names carry digits (Corie618); none may appear at all.
    expect(text).not.toMatch(/\b[A-Z][a-z]+\d{2,3}\b/);
  });
});
