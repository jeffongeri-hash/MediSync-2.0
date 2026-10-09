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
  SMART App Launch v2 PKCE/scope rules before Phase 1 NDJSON and Phase 5 respectively).
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

## Tooling
- Prisma 7: connection URL lives in `prisma.config.ts`; the client needs the `@prisma/adapter-pg` driver
  adapter; the generated client is in `src/generated/prisma` (gitignored, built on `postinstall`).
- Playwright pinned to 1.56.1 to match the container's preinstalled Chromium (revision 1194).
