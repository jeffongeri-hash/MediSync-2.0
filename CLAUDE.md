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
- Setup: `cp .env.example .env`, `pnpm install`, `pnpm db:deploy`, `pnpm db:seed`
- `pnpm dev` (app at :3000, demo at /demo, reconcile at /reconcile) · `pnpm build`
- `pnpm test` (Vitest; DB tests need DATABASE_URL) · `pnpm test:e2e` (Playwright) · `pnpm lint` · `pnpm typecheck`
- `pnpm db:migrate` (new migration) · `pnpm db:deploy` (apply) · `pnpm db:seed` (idempotent Synthea load)
- `pnpm synthea` (regenerate fixtures; needs Java) · `pnpm ndjson` (rebuild NDJSON fixtures from the bundles)
- `pnpm ingest:report [out.md]` (per-patient issue report) · `pnpm demo:snapshot [baseUrl] [out]` (static /demo copy)
- `pnpm map [--all]` (mapping + dedupe pass; db:seed runs it) · `pnpm mapping:report [out.md]` (coverage report)
- `pnpm transfer <patient> [--dry-run] [--out dir] [--report file] [--at instant]` (US Core bundle + fidelity report; `exports/` is gitignored) · API: `POST /api/transfer`, `GET /api/transfer/:id`
- `pnpm eval` (replay recorded Claude answers) · `--live` (needs ANTHROPIC_API_KEY; re-records) · `--template` (no AI) · `--cases a,b` · `--prompts dir` (dump prompts, send nothing) · `--strict` · `--out file` · `pnpm eval:build` (rebuild fixtures/eval from the DB)
- SMART (Phase 5): `/smart/launch` (EHR launch), `/smart/login[?server=name]` (standalone), `/smart/callback`, `/smart` · `pnpm mock:smart` (test-only mock server, iss http://127.0.0.1:4010/fhir) · `pnpm smart:capability [iss | --server name] [--out f] [--raw f]` (write-back report from `{iss}/metadata`) · runbooks: docs/EPIC_SANDBOX.md, docs/ORACLE_SANDBOX.md
- Security (Phase 6): `pnpm roles list|grant <smart:fhirUser> <viewer|provider|admin>|revoke <smart:fhirUser>` · `pnpm crypt:rotate` (re-seal raw_text and bundles with DATA_KEY_ID) · `pnpm audit:verify` · `pnpm audit:export [--from ISO] [--to ISO] [--out f]` · API: `GET /api/admin/audit` (admin) · `DEMO_MODE` opens the seeded patients · checklist: docs/SECURITY.md

## Conventions
- Canonical internal model = FHIR R4 resources validated with Zod. All sources map INTO it; all exports map OUT of it.
- Every mapping is a pure function with unit tests and a fixture.
- Terminology: SNOMED (problems), RxNorm (meds), LOINC (labs), ICD-10 (dx). Unmapped codes go to a review queue, never silently dropped.
- Folder layout: `src/ingest`, `src/canonical`, `src/mapping`, `src/export`, `src/reconcile`, `src/ai`, `src/smart`, `src/audit`, `src/security`, `app/`.
- App logs go through `src/log.ts` (allowlisted fields only), never `console`. Route handlers are wrapped in `guarded()` (`src/http.ts`).

## Project skills
Claude Code loads `.claude/skills/<name>/SKILL.md`. These copies are upstream files, not app logic.

- **apple-design** — `.claude/skills/apple-design/` from [emilkowalski/skills](https://github.com/emilkowalski/skills). Fluid, Apple-style web UI.
- **ponytail** — `.claude/skills/ponytail/` plus `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help` from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail). Smallest change that works.
- **pstack** — `.claude/skills/pstack/<skill>/` from [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude) (`plugins/pstack/skills`). Each skill is linked at `.claude/skills/<skill>/` so Claude Code discovers it. Notices: `.claude/skills/pstack/NOTICE-skills.md`.
- **Anthropic example skills** — `.claude/skills/<name>/` from [anthropics/skills](https://github.com/anthropics/skills): algorithmic-art, brand-guidelines, canvas-design, doc-coauthoring, frontend-design, internal-comms, mcp-builder, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing. Document skills (`docx`, `pdf`, `pptx`, `xlsx`) are not vendored; their LICENSE.txt forbids redistributing copies outside Anthropic services.
