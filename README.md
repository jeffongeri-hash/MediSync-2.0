# MediSync

A SMART on FHIR app for Epic that transfers patient records between EHRs and reconciles outside records
(meds, problems, allergies, PMH), with AI suggestions a provider must accept. **Synthetic data only.**

Status: Phase 0 (scaffold, schema, Synthea seed, intake demo). See `docs/BUILD_PLAN.md`.

## Quick start
Needs Node 22, pnpm 10 and Postgres 16.

```sh
cp .env.example .env      # point DATABASE_URL at your Postgres
pnpm install
pnpm db:deploy && pnpm db:seed
pnpm dev                  # http://localhost:3000/demo
pnpm test
```

More commands are in `CLAUDE.md`. Design decisions are in `docs/DECISIONS.md`, and findings are in `docs/NOTES.md`.
