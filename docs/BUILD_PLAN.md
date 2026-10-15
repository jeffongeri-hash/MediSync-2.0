# MediSync Build Plan (phased, gated)

Each phase ends with a GATE: tests green, short summary (<=10 lines), then STOP. I start a fresh session for the next phase.

## Reality checks (Claude Code: record these in docs/NOTES.md in Phase 0, verify against official docs once)
- Epic third-party apps run through the SMART on FHIR / Epic on FHIR program (fhir.epic.com). Production listing goes through Epic's Showroom (formerly App Orchard) with vendor review. Do NOT plan for that now; build against the free sandbox.
- Epic's FHIR WRITE support for third parties is limited. Plan write-back as: (a) provider-reviewed export package, (b) Epic-supported write endpoints where available, (c) document/C-CDA submission paths. Confirm what the sandbox actually allows in Phase 5 and document it.
- Full chart migration between EHRs is mostly a mapping and data-quality problem, not a UI problem. Sources: FHIR Bulk Data ($export, NDJSON), C-CDA documents, USCDI data classes. TEFCA/Carequality-style exchange is a later integration.
- Compliance (later, not now): HIPAA, BAA with every vendor touching PHI (including the AI vendor), SOC 2, Epic security review.

## Phase 0: Scaffold (small)
Repo, stack from CLAUDE.md, CI, .env.example, Supabase/Postgres schema for: patients, source_records, canonical_resources, mapping_issues, audit_log. Seed with Synthea output (10 patients, FHIR bundles). Gate: `pnpm test` passes, seed loads.

## Phase 1: Ingest + canonical model
Parsers: FHIR R4 bundle + NDJSON bulk, C-CDA (XML) to FHIR. Zod validation. Store raw source untouched plus canonical copy. Cover: Patient, Condition, MedicationRequest/Statement, AllergyIntolerance, Observation (labs/vitals), Immunization, Procedure, Encounter, DocumentReference. Gate: all 10 synthetic patients ingest with an issue report.

## Phase 2: Mapping + terminology
Code-system mapping (SNOMED/RxNorm/LOINC/ICD-10), unit normalization, dedupe, provenance (source system, date, record id). Unmapped codes into the review queue. Gate: mapping coverage report (% mapped by resource type).

## Phase 3: Transfer pipeline (Capability 1 complete)
Target profile (start with a US Core-conformant FHIR bundle). Dry-run diff ("what would transfer, what would be lost or changed"), completeness score, export bundle, job status. Gate: end-to-end transfer of a synthetic patient with a human-readable fidelity report.

## Phase 4: Reconciliation + AI (Capability 2)
Side-by-side reconcile UI: incoming vs. current chart (meds, problems, allergies, PMH). Deterministic rules flag conflicts and duplicates; a cited PMH summary is rule-built by default, or written by Claude when ANTHROPIC_API_KEY is set (optional enhancement: Claude adds AI flags for what the rules cannot see). Accept/reject/edit per item, audit-logged. Evals: 20 synthetic cases checking that every claim has a valid source id and that there are no hallucinated conditions. Gate (no API key needed): key-free eval reported, i.e. the default summary passes the citation and condition checks on all 20 cases, rules catch every rule-detectable injected change, and the scorer rejects bad answers. The Claude pass rate is measured later with `pnpm eval --live` once a key exists; it is not part of the gate.

## Phase 5: SMART launch (Epic and Oracle Health sandboxes)
EHR launch + standalone launch, OAuth2/PKCE, scopes, patient context, fetch via sandbox test patients, for Epic and for Oracle Health (Cerner) Millennium. Embed the Phase 4 UI in the launch flow. Document what write-back each sandbox allows. Gate: launched from each sandbox with a test patient, read plus review flow working.

## Phase 6: Hardening
Role-based access, encryption at rest, audit export, rate limits, error handling, a11y pass, security checklist, README for Epic and Oracle Health review prep. Gate: docs/SECURITY.md checklist with every item done, tested or deferred-with-reason; axe-core finds no serious or critical issues on any page; tests green for roles, rate limits, audit export, tamper evidence and no PHI in logs; README review section written; CI green.

---

## Prompt to paste into Claude Code (Phase 0 start)
Read CLAUDE.md and docs/BUILD_PLAN.md. Execute Phase 0 only. First give me a plan of 15 lines or fewer and wait for my "go". Follow the token-saving protocol. Stop at the gate.
