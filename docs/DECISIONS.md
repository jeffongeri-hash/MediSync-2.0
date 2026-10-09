# Decisions (one line each)

- DB: plain Postgres 16 + Prisma 7 (pg driver adapter) locally and in CI; move to Supabase by changing DATABASE_URL.
- Raw sources stored as `text`, not `jsonb`, so they stay byte-identical; sha256 over original bytes is unique, which makes ingest idempotent.
- `patients` is a patient index; the canonical Patient resource is the source of truth for demographics.
- `audit_log` is append-only (DB trigger blocks UPDATE/DELETE), has no FKs, and `details` holds flat scalars only (no PHI).
- Synthea fixtures (seed 3, 3 years history, FHIR R4 + C-CDA) are committed so CI needs no Java.
- Pinned TypeScript 5.9 and ESLint 9 (not 7 / 10) for Next 16 tooling compatibility.
- `/demo` is server-rendered with no client JS, so `pnpm demo:snapshot` yields a faithful static copy; fonts load from a Google Fonts link (not next/font) for the same reason.
- Every `/demo` view writes one READ audit entry per patient shown.
- E2E (Playwright) runs in CI against `next start`; locally against `next dev`.
