# Notes (spec lookups and environment findings; record once, don't re-fetch)

## Reality checks from BUILD_PLAN (status as of 2026-10-09)
Not yet verified against primary sources: fhir.epic.com, hl7.org and healthit.gov were blocked by the
build container's network policy. Re-check when those hosts are reachable, and no later than Phase 5.
- Epic on FHIR / Showroom listing: unverified. Build against the free sandbox only (per plan).
- Epic write-back: unverified. A secondary search turned up only third-party and 2022 forum sources. They
  suggest Create exists for a limited set (AllergyIntolerance, Observation, DocumentReference; Condition is
  conflicting). Phase 5: read the sandbox CapabilityStatement (`GET {iss}/metadata`) and record exact results here.
  Sources (secondary): https://chat-archive.fhir.org/stream/179166-implementers/topic/EPIC.20FHIR.20rest.20API.html ,
  https://central.ballerina.io/ballerinax/health.clients.fhir.epic/1.0.2
- Bulk Data ($export, NDJSON), C-CDA, USCDI, TEFCA: standard; versions unverified (check the Bulk Data IG and
  SMART App Launch v2 PKCE/scope rules before Phase 5). Phase 1 NDJSON follows the general convention (one
  resource type per file, literal `Type/id` references) without an IG check: hl7.org still blocked on 2026-10-10.
- C-CDA OID -> FHIR system URIs (`src/ingest/ccda/datatypes.ts`) and the US Core race/ethnicity extension shape
  are from memory of FHIR R4 / US Core, not checked against hl7.org. Verify when reachable.
- Compliance (HIPAA, BAAs incl. AI vendor, SOC 2, Epic security review): later phases, unchanged.

## Synthea
- Jar: `master-branch-latest`, pinned by sha256 in `scripts/synthea.sh`. Run with UTF-8 flags, otherwise
  patients with non-ASCII names (e.g. "Jesús") silently fail to export.
- Seed 3, 3 years of history: 10 alive patients, 4 with AllergyIntolerance, all with MedicationRequest,
  ~13 MB total. Seed 42 had zero allergies at any history length, so it was dropped.
- Bundles are `type: transaction` with `urn:uuid:` fullUrls. Organization/Practitioner references are
  conditional (`Organization?identifier=...`), resolved by the separate hospitalInformation*/practitionerInformation*
  bundles (stored as source records with no patient).
- Synthea emits one DocumentReference per Encounter, and heavy Claim/ExplanationOfBenefit volume.
- Names carry digits (Corie618) by design, which marks them as synthetic.
- FHIR output verified byte-identical across two runs (same jar, seed, reference date). C-CDA not checked.
- C-CDA (Phase 1 findings): entry `<id root>` equals the FHIR resource id; timestamps carry no UTC offset but match
  the bundles' UTC times; 35 result values are the literal placeholder `{entry.value}` (Synthea template bug, now
  a WARNING); survey scores appear in both Results and Functional Status (46 WARNING duplicates); encounters have
  no class or status; Plan of Care sections are empty. C-CDA has 734 Observations vs 843 in the bundles.

## Tooling
- Prisma 7: connection URL lives in `prisma.config.ts`; the client needs the `@prisma/adapter-pg` driver
  adapter; the generated client is in `src/generated/prisma` (gitignored, built on `postinstall`).
- Prisma 7 `migrate dev` did not regenerate the client here; run `pnpm db:generate` after a schema change.
- `next dev` writes AGENTS.md (Next.js agent notes) and re-creates it if deleted, so it is committed.
- Playwright pinned to 1.56.1 to match the container's preinstalled Chromium (revision 1194).

## Terminology (Phase 2, 2026-10-10)
- Blocked by the network policy: rxnav.nlm.nih.gov, uts-ws.nlm.nih.gov, clinicaltables.nlm.nih.gov, ucum.nlm.nih.gov. Local tables only.
  Re-verify the code tables and the SNOMED CT to ICD-10-CM crosswalk (NLM's official map) when reachable, no later than Phase 5.
- Crosswalk targets reflect ICD-10-CM changes recalled from memory (M54.50 from FY2022, Z59.82 from FY2023, Z59.10 from FY2024): verify.
- Code tables were curated from the fixtures' own codes, so fixture primary-code coverage is 100% by construction (see
  docs/reports/phase2-mapping.md). All 126 SNOMED CT and 93 LOINC fixture codes pass their check digits.
- Synthea: 9 MedicationRequests use medicationReference to a Medication (2 RxNorm codes); C-CDA carries the RxNorm
  directly, as MedicationStatement under the same id. Every NDJSON and C-CDA row shares an id with a Bundle row, so
  the code + day dedupe fallback is exercised only by unit tests.
- C-CDA Encounter.class is still v3 NullFlavor UNK (Phase 1 gap, unchanged); the linked Bundle Encounter has the class.

## Tooling (Phase 2)
- Prisma refuses `migrate reset` without explicit user consent; seed a fresh database instead.
- `.prettierrc.json` sets printWidth 100, but Phase 1 code was not formatted with it: run Prettier on new files only.

## US Core export (Phase 3, 2026-10-11)
- hl7.org still blocked. From memory and unverified: the US Core 6.1.0 profile URLs, the profile chosen per resource (vital-sign LOINC to profile,
  survey to screening-assessment, exam to simple-observation), mandatory vs must-support elements, and the Provenance participant-type code systems.
  Verify against the IG, and run the official FHIR validator on an exported bundle, when reachable and no later than Phase 5.
- Checked as must-support only because recall of their cardinality is uncertain: MedicationRequest.authoredOn and requester, Observation.effective[x]
  outside vital signs, Procedure.performed[x], DocumentReference.date and author.
- Seeded data: all 10 patients export with nothing excluded, at 92.5% to 97.5% completeness. Every lost element is a Practitioner, Location or
  Organization reference: those resources exist only raw, in the hospitalInformation and practitionerInformation bundles. Adding them to the
  canonical model would close most of the gap.
- C-CDA duplicates carry AllergyIntolerance onset and reaction.severity that the Bundle primary lacks (reported, not merged). C-CDA
  MedicationStatement duplicates of a MedicationRequest are not compared element by element.
- Synthea Bundle codings already have canonical system URIs, displays and UCUM codes, so the seeded export shows no normalization changes; the
  export fixture (fixtures/export) covers those paths.

## Reconciliation + AI (Phase 4, 2026-10-11)
- api.anthropic.com is reachable from the build container (unauthenticated `GET /v1/models` returns 401), but no ANTHROPIC_API_KEY
  is configured, so no live call has been made. The live path (`anthropicResponder`) is covered only by a mocked-client test.
- Anthropic SDK 0.133 (from the bundled claude-api reference, not fetched): Sonnet 5.5 rejects forced `tool_choice` (any/tool) with a 400,
  so structured output goes through `output_config.format` (`betaZodOutputFormat`, passed to `beta.messages.create` and parsed by our
  own validator). `fallbacks: "default"` needs beta `server-side-fallback-2026-07-01`; the serving model is recorded (`servedModel`).
- Not verified live: that `fallbacks: "default"`, `output_config.format` and streaming are accepted together. Run
  `pnpm eval --live --cases case-01` first; a 400 is recorded with the API's message.
- Prompt size over the 20 cases: about 265k characters (roughly 76k input tokens) in total, about 7.6k tokens for the largest case.
- Seeded data findings: C-CDA MedicationStatements are always `completed`, so every active Bundle MedicationRequest shows a status
  conflict; C-CDA copies add allergy onset and reaction severity, and medication dose and end dates (reported as `adds_detail`).
  The seeded data has no therapeutic duplication or allergy-medication conflict among active rows; the eval injects them.
- Phase 3 gaps, now surfaced by reconcile: C-CDA allergy onset and reaction severity show as `adds_detail` on the paired line,
  and C-CDA MedicationStatements are compared with their Bundle MedicationRequest on status, start, end and dose. Still not merged.

## SMART launch (Phase 5, 2026-10-12)
- Still blocked from the build container: every fhir.epic.com path tried (`/metadata`, `/.well-known/smart-configuration`,
  `/oauth2/authorize`, `/oauth2/token` under interconnect-fhir-oauth) fails with proxy CONNECT 403; hl7.org and build.fhir.org
  also 403, so SMART App Launch v2 rules were not re-checked. SMART_CLIENT_ID is not set. Node's fetch here does not use
  HTTPS_PROXY (ENOTFOUND), so `pnpm smart:capability` must run where fhir.epic.com resolves.
- Epic write-back: NOT yet documented from Epic's CapabilityStatement. Pending the manual run in docs/EPIC_SANDBOX.md, which
  writes docs/reports/phase5-writeback-epic-sandbox.md (+ raw JSON). The secondary-source guesses above stay unverified.
- fhirclient 3.0.0: entry points `browser`, `node` (Node req/res) and `hapi` only; `types/types.d.ts` is missing from the
  package, so its public types resolve to `any` (skipLibCheck). `ready()` takes `state` from the URL and looks it up in the
  storage we give it, so binding a launch to the browser comes from the per-cookie storage.
- From memory, unverified against Epic: scope style (SMART v1 `.read` assumed; Epic may grant per its app registration
  regardless), whether Condition search needs `category`, that S256 is listed in `code_challenge_methods_supported`, the
  format of the id_token `fhirUser` claim, that a `http://localhost` redirect URI is accepted for non-production clients,
  and whether the sandbox launches the app in a cross-site iframe (a SameSite=Lax cookie would then not reach the callback).
- Verified only against the test mock (tests/mock-smart): EHR + standalone launch, PKCE, state binding, paging, partial
  read failure, the reconcile flow inside the launch and the dry-run write-back (tests/db/smart.test.ts, tests/e2e/smart.spec.ts).

## Oracle Health sandbox (Phase 5, 2026-10-12)
- Blocked by the network policy (proxy CONNECT 403): fhir-ehr-code.cerner.com, fhir-open.cerner.com, authorization.cerner.com,
  code-console.cerner.com, fhir.cerner.com, docs.oracle.com. Nothing about Oracle Health was verified from here.
- From memory, unverified: sandbox iss `https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d` (secure
  tenant; fhir-open.cerner.com is the unauthenticated twin and is not a SMART server); authorization on authorization.cerner.com;
  SMART v1 and v2 scopes both accepted; provider apps may need `user/` instead of `patient/` scopes; Medication may not be a
  separately readable resource (MedicationRequest carries medicationCodeableConcept); PKCE S256 advertised for public clients.
- Write-back: NOT documented. Pending docs/ORACLE_SANDBOX.md step 6 (docs/reports/phase5-writeback-oracle-sandbox.md).
- Verified only against two mock servers with separate client ids (tests/db/smart.test.ts, tests/e2e/smart.spec.ts).

## Hardening (Phase 6, 2026-10-15)
- Next 16 (from its bundled docs in `node_modules/next/dist/docs/`, not the web): middleware is renamed `proxy.ts` and runs
  on the Node.js runtime; a nonce CSP needs dynamic rendering, so the root layout is `force-dynamic`.
- fhirclient 3 `getFhirUser()` keeps only the last two path segments of the claim (`Practitioner/<id>`), so two EHRs
  could produce the same actor. Phase 6 reads the verified claim itself and stores it absolute.
- Postgres: `ORDER BY id` after `id::text AS "id"` sorts by the text alias (1, 10, 100). Qualify the column
  (`audit_log.id`) when a query renames it.
- Playwright: its TSX transform turns JSX inside imported app components into its own objects, and it cannot load the
  generated Prisma client (ESM). The e2e tests reach the database through the `pnpm roles` CLI instead.
- @axe-core/playwright 4.10.2: axe's stylesheet preload fetches cross-origin CSS (Google Fonts) and trips
  `connect-src 'self'`. The a11y spec turns preload off and checks the page's own CSP report before axe runs.
- `pnpm audit --prod` (2026-10-15): 3 advisories, all in the Prisma CLI's dependencies (`deepmerge-ts` < 8, `mysql2`
  < 3.23.1). Not on the request path; see docs/SECURITY.md item 37.
- Prettier on an existing file reformats unrelated lines and can move `@ts-expect-error` comments off their target
  (it broke `src/audit/audit.test.ts` once). Format new files only.
- Unverified, pending the sandbox runs: which hosts serve Epic's and Oracle Health's id_token issuer and JWKS (Phase 6
  trusts the FHIR server's and the token endpoint's origins), whether either sandbox frames the app (and from which
  origin; Oracle's code console is from memory `https://code-console.cerner.com`), and whether `fhirUser` is absolute.
