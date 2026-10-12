import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const mockPort = Number(process.env.E2E_MOCK_SMART_PORT ?? 4010);

// The app launches against the test-only mock SMART server (tests/mock-smart), never a real EHR. The session key is
// generated per run, so no secret is committed.
const smartEnv = {
  SMART_CLIENT_ID: "medisync-mock-client",
  SMART_ISS: `http://127.0.0.1:${mockPort}/fhir`,
  SMART_REDIRECT_URI: `http://localhost:${port}/smart/callback`,
  SMART_SCOPE: "",
  SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString("base64"),
};

// CI runs against `next start` after `pnpm build`; locally `next dev` is used.
export default defineConfig({
  testDir: "tests/e2e",
  reporter: process.env.CI ? "dot" : "list",
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm mock:smart",
      url: `http://127.0.0.1:${mockPort}/fhir/metadata`,
      env: {
        MOCK_SMART_PORT: String(mockPort),
        MOCK_SMART_CLIENT_ID: smartEnv.SMART_CLIENT_ID,
        MOCK_SMART_REDIRECT_URIS: smartEnv.SMART_REDIRECT_URI,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: process.env.CI ? `pnpm start -p ${port}` : `pnpm dev -p ${port}`,
      url: `http://localhost:${port}`,
      env: smartEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
