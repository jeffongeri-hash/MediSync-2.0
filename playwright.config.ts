import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
// Two test-only mock SMART servers stand in for two EHRs (separate registrations, separate client ids); the app
// never launches against a real EHR here. The session key is generated per run, so no secret is committed.
const mocks = [
  {
    name: "mocka",
    port: Number(process.env.E2E_MOCK_SMART_PORT ?? 4010),
    clientId: "medisync-mock-client",
  },
  {
    name: "mockb",
    port: Number(process.env.E2E_MOCK_SMART_PORT_B ?? 4020),
    clientId: "medisync-mock-second",
  },
];
const redirectUri = `http://localhost:${port}/smart/callback`;
const smartEnv: Record<string, string> = {
  SMART_SERVERS: mocks.map((m) => m.name).join(","),
  SMART_REDIRECT_URI: redirectUri,
  SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(32).toString("base64"),
};
for (const m of mocks) {
  smartEnv[`SMART_${m.name.toUpperCase()}_ISS`] = `http://127.0.0.1:${m.port}/fhir`;
  smartEnv[`SMART_${m.name.toUpperCase()}_CLIENT_ID`] = m.clientId;
}

// CI runs against `next start` after `pnpm build`; locally `next dev` is used.
export default defineConfig({
  testDir: "tests/e2e",
  reporter: process.env.CI ? "dot" : "list",
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    ...mocks.map((m) => ({
      command: "pnpm mock:smart",
      url: `http://127.0.0.1:${m.port}/fhir/metadata`,
      env: {
        MOCK_SMART_PORT: String(m.port),
        MOCK_SMART_CLIENT_ID: m.clientId,
        MOCK_SMART_REDIRECT_URIS: redirectUri,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    })),
    {
      command: process.env.CI ? `pnpm start -p ${port}` : `pnpm dev -p ${port}`,
      url: `http://localhost:${port}`,
      env: smartEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
