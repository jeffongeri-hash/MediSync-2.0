import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Phase 6 gate: axe-core finds no serious or critical WCAG 2.1 A/AA issue on any page, and no page trips the CSP.
// Every page is visited, including the views reached through a SMART launch (mock server, synthetic data).
const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_SMART_PORT ?? 4010}`;
const PATIENT = "Gonzalo160 Wilford267 Hermiston71";

const cspErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  cspErrors.set(page, errors);
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) errors.push(m.text());
  });
});

async function audit(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  // The page's own CSP report, before axe runs (axe's stylesheet preload would fetch cross-origin CSS itself).
  const errors = cspErrors.get(page) ?? [];
  expect(errors, `${label}: CSP violations`).toEqual([]);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .options({ preload: false })
    .analyze();
  errors.length = 0;
  const bad = violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(bad, `${label}: serious or critical axe violations`).toEqual([]);
}

test("start page, intake demo, reconcile list and 404", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.headers()["content-security-policy"]).toMatch(
    /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\d+/,
  );
  expect(res?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res?.headers()["x-frame-options"]).toBeUndefined();
  await audit(page, "/");
  await page.goto("/demo");
  await audit(page, "/demo");
  await page.goto("/reconcile");
  await audit(page, "/reconcile");
  const missing = await page.goto("/no-such-page");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await audit(page, "404");
});

test("reconcile review and edit pages", async ({ page }) => {
  await page.goto("/reconcile");
  await page
    .getByRole("row", { name: new RegExp(PATIENT) })
    .getByRole("button", { name: /^Run/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: PATIENT })).toBeVisible();
  await audit(page, "/reconcile/[patientId]");
  const allergies = page.locator("section", {
    has: page.getByRole("heading", { name: "Allergies" }),
  });
  await allergies.locator("tbody tr").first().getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Edit: / })).toBeVisible();
  await audit(page, "/reconcile/[patientId]/items/[itemId]");
});

test("SMART pages: not launched, an error, and the launched patient", async ({ page, baseURL }) => {
  await page.goto("/smart");
  await audit(page, "/smart (not launched)");
  await page.goto("/smart?error=forbidden");
  await audit(page, "/smart?error");
  await page.goto(`${MOCK}/ehr/launch?app=${encodeURIComponent(`${baseURL}/smart/launch`)}`);
  await expect(page).toHaveURL(/\/smart$/);
  await audit(page, "/smart (launched)");
  await page.getByRole("button", { name: "Start reconciliation" }).click();
  await expect(page).toHaveURL(/\/reconcile\/[0-9a-f-]{36}$/);
  await audit(page, "/reconcile/[patientId] (launched)");
});

test("error page: a form action that fails on the server", async ({ page }) => {
  // A decision posted without its run id fails validation on the server, which renders app/error.tsx (its body,
  // app/error-view.tsx, is also what global-error.tsx shows).
  await page.goto("/reconcile");
  await page
    .getByRole("row", { name: new RegExp(PATIENT) })
    .getByRole("button", { name: /^Run/ })
    .click();
  const form = page.locator("form.decide").first();
  await form.locator('input[name="runId"]').evaluate((el) => el.remove());
  await form.getByRole("button", { name: "Accept" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "This page could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByText(/ZodError|invalid|uuid/i)).toHaveCount(0);
  await audit(page, "error.tsx");
});
