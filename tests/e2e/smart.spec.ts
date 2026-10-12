import { expect, test } from "@playwright/test";

// Phase 5 in a browser, against the test-only mock SMART server (synthetic Synthea data; not the Epic sandbox):
// EHR launch -> authorize -> callback -> read -> reconcile in the launch -> accept -> dry-run write-back; standalone
// launch; and the refusals a browser can see.
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_SMART_PORT ?? 4010}`;
const PATIENT = "Gonzalo160 Wilford267 Hermiston71";
const USER = "Practitioner/mock-practitioner-1";

test.describe.serial("SMART launch (mock server)", () => {
  let reviewUrl = "";

  test("EHR launch opens the patient, reads the chart, and runs the review inside the launch", async ({
    page,
    baseURL,
  }) => {
    await page.goto(`${MOCK}/ehr/launch?app=${encodeURIComponent(`${baseURL}/smart/launch`)}`);
    await expect(page).toHaveURL(/\/smart$/);
    await expect(page.getByRole("heading", { level: 1, name: PATIENT })).toBeVisible();
    const banner = page.getByRole("complementary", { name: "Launch context" });
    await expect(banner).toContainText("EHR launch");
    await expect(banner).toContainText(USER);
    await expect(banner).toContainText("Encounter/");
    await expect(
      page.getByRole("row", { name: /Condition:encounter-diagnosis ok 20/ }),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: /^AllergyIntolerance yes -$/ })).toBeVisible();

    // The outside record of the same synthetic person is pre-selected.
    await expect(page.getByLabel("Outside record", { exact: true })).toHaveValue(/[0-9a-f-]{36}/);
    await page.getByRole("button", { name: "Start reconciliation" }).click();
    await expect(page).toHaveURL(/\/reconcile\/[0-9a-f-]{36}$/);
    reviewUrl = page.url();
    await expect(page.getByRole("heading", { level: 1, name: PATIENT })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Launch context" })).toContainText(USER);
    await expect(
      page.getByRole("columnheader", { name: "Current chart (EHR, at launch)" }).first(),
    ).toBeVisible();

    const allergies = page.locator("section", {
      has: page.getByRole("heading", { name: "Allergies" }),
    });
    const line = allergies.locator("tbody tr").first();
    await line.getByRole("button", { name: "Accept" }).click();
    await expect(allergies.locator("tbody tr").first()).toContainText(`Accepted by smart:${USER}`, {
      timeout: 20_000,
    });

    const writeBack = page.locator("section", {
      has: page.getByRole("heading", { name: /^Write-back \(dry run/ }),
    });
    await expect(writeBack).toBeVisible();
    const href = await writeBack
      .getByRole("link", { name: /Download the package/ })
      .getAttribute("href");
    const pkg = await (await page.request.get(href!)).json();
    expect(pkg).toMatchObject({ dryRun: true, capabilityFrom: `${MOCK}/fhir` });
    expect(pkg.bundle.resourceType).toBe("Bundle");
  });

  test("a launched patient does not open without its launch", async ({ browser }) => {
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    const res = await page.goto(reviewUrl);
    expect(res?.status()).toBe(404);
    await page.goto("/smart");
    await expect(page.getByText("No completed launch in this browser.")).toBeVisible();
    await fresh.close();
  });

  test("standalone launch picks the patient at the server and has no encounter context", async ({
    browser,
  }) => {
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.goto("/smart");
    await page.getByRole("link", { name: "Standalone launch" }).click();
    await expect(page).toHaveURL(/\/smart$/);
    const banner = page.getByRole("complementary", { name: "Launch context" });
    await expect(banner).toContainText("Standalone launch");
    await expect(banner).not.toContainText("Encounter/");
    await fresh.close();
  });

  test("an iss outside the allowlist is refused before any redirect", async ({ page }) => {
    await page.goto("/smart/launch?iss=https%3A%2F%2Fevil.example%2Ffhir&launch=x");
    await expect(page).toHaveURL(/\/smart\?error=iss_not_allowed$/);
    await expect(page.locator(".notice")).toHaveText(
      "This FHIR server (iss) is not on the allowlist.",
    );
  });
});
