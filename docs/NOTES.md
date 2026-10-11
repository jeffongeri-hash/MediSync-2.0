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
