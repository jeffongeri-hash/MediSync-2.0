import { expect, test } from "@playwright/test";

// Synthea seed 3 patient with allergies and Medication references (source Patient.id c4a5ef89-...).
const PATIENT = "Gonzalo160 Wilford267 Hermiston71";

test("run a reconciliation, review the cited summary, accept a line and save an edited copy", async ({
  page,
}) => {
  await page.goto("/reconcile");
  const row = page.getByRole("row", { name: new RegExp(PATIENT) });
  await row.getByRole("button", { name: /^Run/ }).click();

  await expect(page.getByRole("heading", { level: 1, name: PATIENT })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
  // Without an API key the summary comes from the template, and says so.
  await expect(page.getByText(/Template \(no AI|Claude/).first()).toBeVisible();
  for (const name of ["Problems", "Medications", "Allergies"])
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  const firstCite = page.locator(".claim .cite").first();
  await expect(firstCite).toHaveText(/^[CI]\d+$/);

  const allergies = page.locator("section", {
    has: page.getByRole("heading", { name: "Allergies" }),
  });
  const line = allergies.locator("tbody tr").first();
  await expect(line).toContainText(/adds|Same|Differs/);
  await line.getByRole("button", { name: "Accept" }).click();
  await expect(allergies.locator("tbody tr").first()).toContainText("Accepted by demo:provider", {
    timeout: 20_000,
  });

  await allergies.locator("tbody tr").first().getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Edit: / })).toBeVisible();
  const editor = page.locator("textarea#edited");
  await editor.fill("{ not json");
  await page.getByRole("button", { name: "Save edited copy" }).click();
  await expect(page.locator(".notice")).toHaveText("The edited copy is not valid JSON.", {
    timeout: 20_000,
  });

  await page.goto(page.url().split("?")[0]!);
  const draft = await page.locator("textarea#edited").inputValue();
  const resource = JSON.parse(draft);
  resource.note = [{ text: "Confirmed with patient" }];
  await page.locator("textarea#edited").fill(JSON.stringify(resource));
  await page.getByLabel("Note (optional)").fill("e2e edit");
  await page.getByRole("button", { name: "Save edited copy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: PATIENT })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText(/Edited copy saved by demo:provider.*\(e2e edit\)/).first(),
  ).toBeVisible();
});
