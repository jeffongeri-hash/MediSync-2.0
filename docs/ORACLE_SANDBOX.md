# Oracle Health sandbox runbook (Phase 5 gate, manual)

Oracle Health (formerly Cerner) Millennium, launched from its code-console sandbox. The build container cannot reach the
Oracle Health hosts (network policy), so these steps run on your machine. The launch flow is the same code path as
Epic's and is covered by tests against two local mock servers. Synthetic data only: use the sandbox's test patients.

Oracle Health's screens, hosts and field names below are from memory and unverified; follow Oracle Health's developer
documentation where it differs, and note the difference in docs/NOTES.md.

## 1. Register an app (Oracle Health code console)

- Application type: provider (SMART app launched by clinicians; needed for EHR launch). Standalone launch uses the same
  client id.
- FHIR R4. Public client (PKCE S256, no client secret). Online access is enough; MediSync does not ask for refresh tokens.
- SMART launch URI: `http://localhost:3000/smart/launch`. Redirect URI: `http://localhost:3000/smart/callback` (the
  same one Epic's registration uses; it must match `SMART_REDIRECT_URI` exactly).
- Read access: Patient, Condition, MedicationRequest, Medication, AllergyIntolerance, Encounter. No write access.
- Copy the client id, and the FHIR base URL (iss) the console shows for the sandbox tenant.

## 2. Configure and start

```
# .env (both EHRs; drop "epic" to run Oracle only)
SMART_SERVERS=epic,oracle
SMART_ORACLE_CLIENT_ID=<client id from the code console>
SMART_ORACLE_ISS="https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d"   # confirm in the console
# SMART_ORACLE_SCOPE=...   only if the sandbox rejects a default scope (see "If it fails")
SMART_REDIRECT_URI="http://localhost:3000/smart/callback"
SESSION_SECRET=<openssl rand -base64 32>
pnpm db:deploy && pnpm db:seed && pnpm dev
```

## 3. Standalone launch

Open `http://localhost:3000/smart`, click **Standalone launch: Oracle Health sandbox (oracle)**, sign in with the
sandbox provider account from Oracle Health's documentation, and pick a test patient. You should land on `/smart` with
"Oracle Health sandbox" in the banner and the **Read at launch** table.

## 4. EHR launch

From your app in the code console, start the sandbox test launch (it opens `/smart/launch` with the sandbox's iss and a
launch token). Same landing page, with "EHR launch" in the banner.

## 5. Read and review flow (the gate)

Pick an outside record (a synthetic Synthea C-CDA), **Start reconciliation**, accept or reject a few lines, and check
the **Write-back (dry run, not sent)** section. Nothing is written to Oracle Health.

## 6. Record the write-back the sandbox allows

```
pnpm smart:capability --server oracle --raw docs/reports/oracle-sandbox-capability.json
```

Reads `{iss}/metadata` and writes `docs/reports/phase5-writeback-oracle-sandbox.md`. Commit both files.

## What to send back

- The **Read at launch** table for both launches, or the error shown on `/smart`.
- The **User** and **Role** lines of the launch banner (Phase 6 verifies the id_token).
- The two report files above (committed), or the `smart:capability` error.
- The iss the console showed, if it differs from the one above, and anything the screens did differently.

## If it fails

Same error table as docs/EPIC_SANDBOX.md. Oracle-specific things to check first (all unverified):

| Symptom | Likely cause and fix |
| --- | --- |
| iss not on the allowlist | the console's iss differs from `SMART_ORACLE_ISS` (tenant id, `/r4` path); copy it exactly |
| declined the request (`invalid_scope`) | a default scope is not granted to the registration, e.g. `patient/Medication.read`; set `SMART_ORACLE_SCOPE` to the granted read scopes (or `user/<Type>.read` for provider apps) |
| could not read the SMART configuration | `.well-known/smart-configuration` unreachable, or S256 not advertised (PKCE is required) |
| a query shows failed in the Read table | that search needs a parameter or type Oracle does not support; the rest of the record still loads |
| User: not verified (id_token: …), Role: viewer | the id_token failed the Phase 6 check and the launch is read-only. Its issuer and JWKS must be on the FHIR server's host or the token endpoint's (authorization.cerner.com); send the reason back |
