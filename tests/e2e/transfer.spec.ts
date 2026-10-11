import { expect, test } from "@playwright/test";

const GATE_PATIENT = "c4a5ef89-933c-c428-8fa7-4a26d9f621a9"; // Synthea seed 3 source Patient.id

test("a dry-run transfer job runs over the API and its status can be read back", async ({
  request,
}) => {
  const res = await request.post("/api/transfer", { data: { patient: GATE_PATIENT } });
  expect(res.status()).toBe(200);
  const job = await res.json();
  expect(job).toMatchObject({
    status: "SUCCEEDED",
    dryRun: true,
    targetProfile: "us-core@6.1.0",
    resourcesExcluded: 0,
  });
  expect(job.completeness).toBeGreaterThan(0.95);
  expect(job.report).toContain("# Transfer fidelity report");
  expect(job).not.toHaveProperty("bundle");

  const again = await request.get(`/api/transfer/${job.id}`);
  expect(again.status()).toBe(200);
  expect(await again.json()).toMatchObject({
    id: job.id,
    status: "SUCCEEDED",
    bundleSha256: job.bundleSha256,
  });
});

test("the transfer API rejects bad input and unknown ids", async ({ request }) => {
  expect((await request.post("/api/transfer", { data: { dryRun: true } })).status()).toBe(400);
  expect(
    (await request.post("/api/transfer", { data: { patient: "no-such-patient" } })).status(),
  ).toBe(404);
  expect((await request.get("/api/transfer/00000000-0000-4000-8000-000000000000")).status()).toBe(
    404,
  );
  expect((await request.get("/api/transfer/not-a-uuid")).status()).toBe(404);
});
