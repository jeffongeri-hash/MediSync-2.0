import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// Phase 6 roles in a browser, on the second mock server (its user is not used for writes by other specs). A
// provider opens a review; once the user is a viewer (granted with the `pnpm roles` CLI), the server refuses a
// decision posted from the open page.
const MOCK_B = `http://127.0.0.1:${process.env.E2E_MOCK_SMART_PORT_B ?? 4020}`;
const ACTOR = `smart:${MOCK_B}/fhir/Practitioner/mock-practitioner-1`;
const roles = (...args: string[]) =>
  execFileSync("pnpm", ["-s", "roles", ...args], { encoding: "utf8", stdio: "pipe" });

test("a viewer reads a launch, sees no write controls, and the server refuses a decision", async ({
  page,
  baseURL,
}) => {
  try {
    await page.goto(`${MOCK_B}/ehr/launch?app=${encodeURIComponent(`${baseURL}/smart/launch`)}`);
    await expect(page).toHaveURL(/\/smart$/);
    const banner = page.getByRole("complementary", { name: "Launch context" });
    await expect(banner).toContainText("provider");
    await page.getByRole("button", { name: "Start reconciliation" }).click();
    await expect(page).toHaveURL(/\/reconcile\/[0-9a-f-]{36}$/);
    const review = page.url();

    expect(roles("grant", ACTOR, "viewer")).toContain("is now viewer");
    const allergies = page.locator("section", {
      has: page.getByRole("heading", { name: "Allergies" }),
    });
    await allergies.locator("tbody tr").first().getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("This needs the provider role; you have viewer.")).toBeVisible();
    await expect(allergies.locator("tbody tr").first()).not.toContainText("Accepted by");

    await page.goto(review);
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expect(page.getByText(/needs the provider role/).first()).toBeVisible();
    await page.goto("/smart");
    await expect(page.getByRole("button", { name: "Start reconciliation" })).toHaveCount(0);
    await expect(banner).toContainText("viewer");
  } finally {
    roles("revoke", ACTOR);
  }
});
