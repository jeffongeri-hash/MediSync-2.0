# Security checklist

Phase 6 controls, as of 2026-10-15. Every item has one status:

- **tested**: in place, and the named test fails if it breaks.
- **done**: in place and checked by reading the code or config named, with no dedicated test.
- **deferred**: not in place. The reason says why and what closes it.

Scope: synthetic data only (Synthea and EHR sandbox test patients). Items that only matter once real PHI is
involved are deferred, not skipped.

## Identity and access

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Identity comes only from a SMART on FHIR launch (EHR or standalone, PKCE S256). MediSync stores no passwords. | tested | `tests/db/smart.test.ts`, `tests/e2e/smart.spec.ts` |
| 2 | The id_token is verified: RS256 or ES256 signature against the JWKS from OIDC discovery, `iss`, `aud` = client id, `exp`, `iat`. Discovery and keys are fetched only from the FHIR server's origin or the token endpoint's. | tested | `src/smart/idtoken.test.ts`, `tests/db/smart.test.ts` |
| 3 | A launch without a verified user acts as `smart:unknown-user` with the viewer role. That actor cannot be granted a role. The banner shows the failed check. | tested | `tests/db/smart.test.ts` (forged key), `tests/db/security.test.ts` |
| 4 | Roles: viewer reads; provider also starts reconciliations, records decisions, downloads the write-back package and runs transfers; admin also exports the audit log. A Practitioner or PractitionerRole fhirUser is provider by default, anyone else viewer. `pnpm roles grant\|revoke\|list` changes grants, and each change is audited. | tested | `src/security/roles.test.ts`, `tests/db/security.test.ts`, `tests/e2e/roles.spec.ts` |
| 5 | Roles are enforced on the server, not only hidden in the UI: route handlers return 403, server actions redirect with the role message. | tested | `tests/db/security.test.ts` (routes), `tests/e2e/roles.spec.ts` (a decision posted after the user became a viewer is refused) |
| 6 | Patient context: a patient read through a launch opens only in that launch's session; any other patient is a 404. | tested | `tests/db/security.test.ts`, `tests/e2e/smart.spec.ts` |
| 7 | Demo mode: the seeded Synthea patients (`/demo`, `/reconcile`, `/api/transfer`) open without a login only when `DEMO_MODE` is on. It is off by default in a production build. | tested | `src/security/roles.test.ts`, `tests/db/security.test.ts` |
| 8 | `/api/transfer` needs a launched session (or demo mode), the provider role, and the session's own patient. | tested | `tests/db/security.test.ts` |
| 9 | Session: a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (8 h); the database stores only its sha256. `SESSION_COOKIE_SAMESITE=none` switches to `SameSite=None`, over HTTPS only. | tested | `src/smart/smart.test.ts`, `src/security/headers.test.ts` |
| 10 | SMART access tokens are sealed with AES-256-GCM (`SESSION_SECRET`) while the launch runs and discarded after the launch read. No refresh tokens are requested. | tested | `tests/db/smart.test.ts` |

## Data protection

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 11 | `source_records.raw_text` and stored transfer bundles are sealed with AES-256-GCM. Each value carries its key id, and the row's sha256 is the associated data, so a value cannot be moved to another row. | tested | `src/security/crypt.test.ts`, `tests/db/seed.test.ts`, `tests/db/transfer.test.ts`; CI runs with a per-run key |
| 12 | A production build refuses to store raw text or a bundle without `DATA_KEYS`. | tested | `src/security/crypt.test.ts` |
| 13 | Key rotation: add a key, point `DATA_KEY_ID` at it, run `pnpm crypt:rotate` (also run by `pnpm db:seed`), then remove the old key. Plaintext rows are sealed by the same command. | tested | `src/security/crypt.test.ts` (two keys), `tests/db/security.test.ts` (plaintext row sealed, second run changes nothing) |
| 14 | Database-level encryption at rest and TLS to the database. | deferred | Supabase encrypts storage; it cannot be checked from this container. At deployment, confirm it in the Supabase project and use `sslmode=require` in `DATABASE_URL`. |
| 15 | Field-level encryption of `canonical_resources` JSON, reconciliation rows and summaries. | deferred | Mapping, dedupe and reconcile read these columns and query by type. They rely on item 14. Revisit if a reviewer requires field-level encryption for them. |
| 16 | `DATA_KEYS` and `SESSION_SECRET` are kept in a key management service. | deferred | They are environment variables today. Move them to the host's secret manager or a KMS at deployment. |
| 17 | No secrets in the repository: `.env` is ignored, `.env.example` holds placeholders, and CI generates its data key per run. | done | `.gitignore`, `.env.example`, `.github/workflows/ci.yml` |

## Audit

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 18 | Every read and write of patient data writes an `audit_log` row: actor, action, time, patient, source. `details` holds ids and counts only. | tested | `tests/db/seed.test.ts`, `tests/db/reconcile.test.ts`, `tests/db/smart.test.ts`, `tests/db/security.test.ts` |
| 19 | `audit_log` is append-only: a trigger blocks UPDATE and DELETE. | tested | `tests/db/seed.test.ts` |
| 20 | Tamper evidence: the insert trigger chains each row to the previous one (`hash` = sha256 over `prev_hash` and the row's fields). `pnpm audit:verify` finds an edited, deleted or reordered row. | tested | `src/audit/chain.test.ts`, `tests/db/security.test.ts` (edit and delete, in a rolled-back transaction) |
| 21 | Audit export: `pnpm audit:export [--from] [--to] [--out]` and admin-only `GET /api/admin/audit` return NDJSON. Each verifies the chain first, ends with a `{"chain": ...}` line (verified, head hash), and writes an EXPORT audit row for the export itself. | tested | `tests/db/security.test.ts` |
| 22 | The chain head is anchored outside the database. | deferred | Someone with database superuser rights could delete the newest rows and the remaining chain would still verify. Keep each export's head hash and check that the next export contains it; automate this when exports go to external storage. |

## HTTP surface

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 23 | Rate limits, counted in Postgres per session or per hashed client IP: launch 20/min, transfer runs 10/min, transfer reads 60/min, decisions and write-back 60/min, audit export 5/min. Over the limit: 429 with `Retry-After`. | tested | `tests/db/security.test.ts` |
| 24 | `TRUST_PROXY=1` behind the load balancer, so per-IP limits see the client address. | deferred | Deployment setting. Without it, requests with no session share one bucket per rule. The IP is stored only as a hash. |
| 25 | Security headers on every response: nonce-based CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (launch URLs carry `launch`, `code` and `state`), `Permissions-Policy`, `Cross-Origin-Resource-Policy`, and HSTS over HTTPS. | tested | `src/security/headers.test.ts`, `tests/e2e/a11y.spec.ts` (headers on a live response; no CSP violation on any page) |
| 26 | Embedding: CSP `frame-ancestors` allows `'self'` plus each configured EHR (`SMART_<NAME>_FRAME_ANCESTORS`, default: the origin of its iss). `X-Frame-Options` is not sent because it cannot name allowed hosts. | tested | `src/security/headers.test.ts` |
| 27 | `Cross-Origin-Opener-Policy`. | deferred | An EHR launcher may keep a handle on the app window. Decide after the Epic and Oracle Health sandbox runs show how they open the app. |
| 28 | Input from users and EHRs is validated at the boundary: Zod on API bodies, form posts and FHIR resources; UUID checks on ids; SMART parameters never reach fhirclient unvalidated. | done | `app/api/transfer/route.ts`, `app/reconcile/actions.ts`, `src/smart/adapter.ts`, `src/canonical/` |
| 29 | Outbound requests stay on known hosts: FHIR reads only on the launch's iss, id_token discovery only on the iss or token endpoint origin, and an iss outside `SMART_*` is refused. | tested | `src/smart/smart.test.ts`, `src/smart/idtoken.test.ts`, `tests/e2e/smart.spec.ts` |
| 30 | Errors: an API failure returns `{error, requestId}` with no message or stack; error pages show a reference, never the message. | tested | `src/log.test.ts`, `tests/e2e/a11y.spec.ts` (a failing form action renders the error page) |

## Logging

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 31 | No PHI in application logs: `src/log.ts` writes an event name plus allowlisted, non-identifying fields. In production, every server `console` call goes through the same filter (`instrumentation.ts`). | tested | `src/log.test.ts`, `tests/db/logs.test.ts` (ingest, mapping, transfer, reconcile and the API, checked for every seeded name, birth date and id) |
| 32 | Log shipping, retention and alerting. | deferred | Depends on the host. Configure at deployment. |

## AI

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 33 | AI output is a suggestion. Every claim cites a source row the model was sent; nothing reaches the chart without a provider's accept. | tested | `src/ai/eval.test.ts`, `src/ai/ai.test.ts` |
| 34 | Records go to Anthropic only with `ANTHROPIC_API_KEY` set, and each send is an EXPORT audit row. | tested | `tests/db/reconcile.test.ts` (EXPORT row for a model run, none for the rule-built summary) |
| 35 | A BAA with Anthropic before any real PHI is sent. | deferred | Compliance step for real data. |

## Accessibility

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 36 | axe-core (WCAG 2.1 A and AA) finds no serious or critical issue on any page, including the launched views and the error page. | tested | `tests/e2e/a11y.spec.ts` |

## Dependencies and compliance

| # | Control | Status | Evidence |
| --- | --- | --- | --- |
| 37 | `pnpm audit --prod` reports 3 advisories, all in the Prisma CLI's dependencies: `deepmerge-ts` < 8 (high) and `mysql2` < 3.23.1 (high, moderate). | deferred | Neither runs on the app's request path: `mysql2` serves MySQL connections (MediSync uses Postgres), and `deepmerge-ts` merges Prisma's own config. Take the fix with the next Prisma release; forcing the overrides risks breaking the CLI. |
| 38 | HIPAA risk assessment, BAAs with every vendor that touches PHI, SOC 2. | deferred | Not started; no real PHI is in scope (BUILD_PLAN reality checks). |
| 39 | Epic and Oracle Health security reviews, and an external penetration test. | deferred | They need the Phase 5 sandbox runs first. See "Prepare for EHR review" in the README. |
| 40 | Backups, restore drills and disaster recovery. | deferred | Supabase-managed. Set them up with the production project. |
