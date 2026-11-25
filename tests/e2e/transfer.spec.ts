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

test("on /demo a provider dry-runs a transfer, approves it, and EHR B receives the record", async ({
  page,
}) => {
  await page.goto("/demo");
  const section = page.locator("#transfer");
  await expect(section.getByRole("heading", { name: "Transfer between EHRs" })).toBeVisible();
  await section.getByLabel("Patient").selectOption({ label: "Gonzalo160 Wilford267 Hermiston71" });
  await section.getByRole("button", { name: "1. Run dry run" }).click();

  await expect(section.getByRole("heading", { name: /^Dry run for Gonzalo160/ })).toBeVisible();
  await expect(section.getByRole("columnheader", { name: "Completeness" })).toBeVisible();
  await expect(section.getByRole("rowheader", { name: "Condition" })).toBeVisible();

  // Sending needs the provider's confirmation that they read the report.
  const send = section.getByRole("button", { name: "2. Approve and send" });
  await section.getByLabel(/I read the fidelity report/).check();
  await section.getByLabel("to").selectOption("ehrb");
  await send.click();

  const status = section.getByRole("status");
  await expect(status).toContainText("Delivered to EHR B (mock).");
  await expect(status).toContainText(/Patient\/rx-\d+/);
  await expect(status).toContainText("matches the approved dry run");
  await expect(
    section.getByRole("columnheader", { name: "Created in EHR B (mock)" }),
  ).toBeVisible();
  await expect(send).toHaveCount(0);
});

test("the send API refuses a second send of the same dry run and a real dry run's bad target", async ({
  request,
}) => {
  const dry = await (
    await request.post("/api/transfer", { data: { patient: GATE_PATIENT } })
  ).json();
  const first = await request.post(`/api/transfer/${dry.id}/send`, { data: { target: "ehrb" } });
  expect(first.status()).toBe(200);
  const sent = await first.json();
  expect(sent).toMatchObject({ dryRun: false, approvedJobId: dry.id, target: "ehrb" });
  expect(sent.delivery.targetPatientId).toMatch(/^rx-\d+$/);
  expect(sent.bundleSha256).toBe(dry.bundleSha256);

  const again = await request.post(`/api/transfer/${dry.id}/send`, { data: { target: "ehrb" } });
  expect(again.status()).toBe(409);
  const other = await (
    await request.post("/api/transfer", { data: { patient: GATE_PATIENT } })
  ).json();
  expect(
    (await request.post(`/api/transfer/${other.id}/send`, { data: { target: "epic" } })).status(),
  ).toBe(409);
  expect((await request.post(`/api/transfer/${other.id}/send`, { data: {} })).status()).toBe(400);
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
