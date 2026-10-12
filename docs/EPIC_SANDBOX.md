# Epic sandbox runbook (Phase 5 gate, manual)

The build container cannot reach fhir.epic.com (network policy), so the steps below run on your machine. Everything up
to the Epic login is covered by tests against a local mock (`tests/mock-smart`); these steps prove it against Epic and
record what write-back the sandbox allows. Synthetic data only: use Epic's published sandbox test patients.

Epic's screens and field names below are from memory and unverified; follow fhir.epic.com where it differs, and note
the difference in docs/NOTES.md.

## 1. Register a non-production app (fhir.epic.com, "Build Apps")

- Audience: clinicians / administrative users (provider-facing; needed for EHR launch). Standalone launch uses the same
  client id.
- SMART on FHIR, FHIR R4. Public client: no client secret, no JWKS (MediSync always sends PKCE S256).
- Redirect URI: `http://localhost:3000/smart/callback` (must match `SMART_REDIRECT_URI` exactly).
- EHR launch URL: `http://localhost:3000/smart/launch`.
- APIs (read only): Patient read/search, Condition search (problems, encounter diagnoses, health concerns),
  MedicationRequest search, Medication read, AllergyIntolerance search, Encounter search. No write APIs in Phase 5.
- Copy the non-production client id. Epic may take a while before a new or changed registration works.

## 2. Configure and start

```
cp .env.example .env
# SMART_CLIENT_ID=<non-production client id>
# SMART_ISS="https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"
# SMART_REDIRECT_URI="http://localhost:3000/smart/callback"
# SESSION_SECRET=<openssl rand -base64 32>
pnpm install && pnpm db:deploy && pnpm db:seed
pnpm dev
```

## 3. Standalone launch

Open `http://localhost:3000/smart`, click **Standalone launch**, sign in at Epic with a sandbox test user from
fhir.epic.com's test data page, and pick a test patient. You should land back on `/smart` with the launch banner (server,
user, patient) and the **Read at launch** table.

## 4. EHR launch

From your app's page on fhir.epic.com, use Epic's sandbox launcher with launch URL `http://localhost:3000/smart/launch`
and a test patient. Same landing page, with "EHR launch" in the banner (and an encounter if Epic sends one).

## 5. Read and review flow (the gate)

On `/smart`: pick an outside record (a synthetic Synthea C-CDA; Epic's test patients are different people, so most
lines show as new), **Start reconciliation**, accept or reject a few lines, and check the **Write-back (dry run, not
sent)** section. Nothing is written to Epic.

## 6. Record the write-back the sandbox allows

```
pnpm smart:capability --raw docs/reports/epic-sandbox-capability.json
```

Reads `{iss}/metadata` (public) and writes `docs/reports/phase5-writeback.md`. Commit both files.

## What to send back

- The **Read at launch** table (query, ok/failed, counts) for both launches, or the error shown on `/smart`.
- The two report files above (committed), or the `smart:capability` error.
- Anything Epic's screens did differently from this page.

## If it fails

| Shown on /smart | Likely cause |
| --- | --- |
| not configured | a SMART_* variable or SESSION_SECRET is missing (`.env`) |
| iss not on the allowlist | the launcher's iss differs from SMART_ISS (check the exact URL, trailing parts) |
| could not read the SMART configuration | `.well-known/smart-configuration` unreachable, or S256 not advertised (PKCE is required) |
| declined the request | Epic returned `error` (wrong client id, redirect URI or scopes; or not yet propagated) |
| no launch in progress / does not belong to this launch | the session cookie did not come back to the callback, e.g. the launcher embeds the app in a cross-site iframe; open it in a new window |
| code could not be exchanged | token endpoint refused the code or verifier |
| no patient context | no `patient` in the token response (standalone: no patient picked) |
| record could not be read | the Patient read failed; per-query failures appear in the Read table instead |

## Local mock (no Epic)

`pnpm mock:smart` starts the test-only mock at `http://127.0.0.1:4010/fhir` (client id `medisync-mock-client`). With
`SMART_ISS` and `SMART_CLIENT_ID` set to those values, `/smart/login` works offline, and the EHR launch URL the mock prints
simulates an EHR launch. The mock's CapabilityStatement is a test fixture; never use its report as Epic's.
