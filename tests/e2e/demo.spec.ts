import { expect, test } from "@playwright/test";

test("landing page links to the intake demo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open the intake demo" }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole("heading", { level: 1, name: "Intake demo" })).toBeVisible();
});

test("demo lists the 10 seeded patients and audits the view", async ({ page }) => {
  await page.goto("/demo");
  const patients = page.locator("section[aria-labelledby=patients-h] tbody tr");
  await expect(patients).toHaveCount(10);
  await expect(page.locator("section[aria-labelledby=sources-h] details")).toHaveCount(10);
  await expect(page.locator("section[aria-labelledby=audit-h] tbody").getByText("READ").first()).toBeVisible();
});

test("demo has no horizontal page scroll at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
