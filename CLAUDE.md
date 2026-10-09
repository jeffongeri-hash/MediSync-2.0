# MediSync: EHR Transfer + Record Reconciliation

Goal: a SMART on FHIR app that lives inside Epic, with two capabilities:
1. Cross-EHR patient record transfer (ingest, normalize, map, validate, export).
2. Outside-record reconciliation (PMH, meds, allergies, problems) with AI summarization and provider accept/reject.

## Hard rules (read first, always)
- SYNTHETIC DATA ONLY. Never use, request, or commit real PHI. Use Synthea + Epic sandbox test patients.
- No secrets in the repo. Use .env (gitignored) and .env.example.
- AI output is a suggestion. Nothing writes to a chart without explicit provider accept. Every AI claim must cite its source record id.
- Log every read/write to an audit table (who, what, when, patient, source). No PHI in application logs.
- Original products only. Do not copy Doximity or DrFirst UI, branding, or code. Match the workflow value, not the look.

## Stack (decided, do not re-debate)
Next.js (App Router) + TypeScript, Postgres (Supabase), Prisma, Zod, `fhirclient` for SMART launch, Vitest + Playwright, Anthropic SDK for summarization/mapping assist.

## Token-saving protocol (follow strictly)
- Work in PHASES from docs/BUILD_PLAN.md. Do ONE phase per session. Stop at the phase gate and wait.
- Plan before code: for each phase, write a <=15-line plan, wait for my "go", then implement.
- Do not re-read files you just wrote. Do not dump whole files into chat. Use Grep/Glob with narrow patterns, and Read with offset/limit.
- No subagents unless I ask. No web browsing unless the task needs a spec lookup (cite the URL once, then record the finding in docs/NOTES.md so it is never fetched twice).
- Keep this file under 120 lines. Put durable decisions in docs/DECISIONS.md (one line each) instead of repeating them in chat.
- Run tests with quiet output (`--reporter=dot`, tail the last 30 lines). Show only failures.
- Prefer small diffs via Edit over rewriting files. Commit after each passing step with a one-line message.
- At ~60% context, run /compact with focus: "current phase, open TODOs, decisions". Start a fresh session at each phase gate.
- When uncertain about requirements, ask ONE batched question, not several round trips.

## Commands
- `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm db:migrate`
(Fill in after Phase 0 scaffolding.)

## Conventions
- Canonical internal model = FHIR R4 resources validated with Zod. All sources map INTO it; all exports map OUT of it.
- Every mapping is a pure function with unit tests and a fixture.
- Terminology: SNOMED (problems), RxNorm (meds), LOINC (labs), ICD-10 (dx). Unmapped codes go to a review queue, never silently dropped.
- Folder layout: `src/ingest`, `src/canonical`, `src/mapping`, `src/export`, `src/reconcile`, `src/ai`, `src/smart`, `src/audit`, `app/`.
