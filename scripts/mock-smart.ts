// Runs the TEST-ONLY mock SMART server (tests/mock-smart/server.ts) for Playwright and local demos. It serves synthetic
// Synthea patients and is not the Epic sandbox. Env: MOCK_SMART_PORT (4010), MOCK_SMART_CLIENT_ID, MOCK_SMART_REDIRECT_URIS.
import { join } from "node:path";
import { startMockSmart } from "../tests/mock-smart/server";

export const MOCK_PATIENT_FILES = [
  "Gonzalo160_Hermiston71_c4a5ef89-933c-c428-8fa7-4a26d9f621a9.json",
  "Erik495_Hermiston71_a90ab4e3-5a52-2884-aadc-32cd5ec6357d.json",
];

async function main() {
  const mock = await startMockSmart({
    port: Number(process.env.MOCK_SMART_PORT ?? 4010),
    clientId: process.env.MOCK_SMART_CLIENT_ID ?? "medisync-mock-client",
    redirectUris: (
      process.env.MOCK_SMART_REDIRECT_URIS ??
      "http://localhost:3000/smart/callback,http://localhost:3100/smart/callback"
    ).split(","),
    bundles: MOCK_PATIENT_FILES.map((f) => join(process.cwd(), "fixtures/synthea/fhir", f)),
  });
  console.log(`mock SMART server (test only, synthetic data): iss=${mock.iss}`);
  console.log(`EHR launch: ${mock.ehrLaunchUrl("http://localhost:3000/smart/launch")}`);
  const stop = () => void mock.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
