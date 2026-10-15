# Security

Reference for what this app enforces. Synthetic data only. Do not send real patient information.

## Access

Three bearer tokens, set in the environment:

| Token                     | Can                                                                      |
| ------------------------- | ------------------------------------------------------------------------ |
| `MEDISYNC_REVIEWER_TOKEN` | Dry-run transfer, read a transfer job, open the demo and reconcile pages |
| `MEDISYNC_EXPORTER_TOKEN` | Everything a reviewer can do, plus a real export (`dryRun: false`)       |
| `MEDISYNC_AUDITOR_TOKEN`  | `GET /api/audit` only                                                    |

Send `Authorization: Bearer <token>`. The review pages take the same token from the sign-in form and keep it in an httpOnly, SameSite=lax cookie named `medisync_session` for 8 hours. The cookie is not marked Secure, so sign-in works on http://localhost. Mark it Secure when the site is served only over HTTPS.

If none of the three tokens is set, API and pages stay open and reconcile decisions are attributed to `demo:provider`. That is the local demo and CI. Set any one token and every check fails closed: a missing or unknown token is 401, a known token without the permission is 403.

The transfer API still returns job status and the fidelity report, never the bundle.

## Encryption

`transfer_jobs.bundle` is AES-256-GCM (`enc1:`) under `MEDISYNC_DATA_KEY` (32 bytes, base64). The job stores the sha256 and byte length of the plaintext. A real export refuses to write the bundle if the key is missing. `pnpm transfer` still writes the plaintext bundle into `exports/`, which is gitignored.

Raw source text stays plaintext in `source_records.raw_text`. Ingest idempotency is the sha256 of those exact bytes. Disk encryption has to cover that column. Supabase encrypts volumes. A local Postgres does not, unless you turn that on yourself.

## Audit export

`GET /api/audit` returns NDJSON (`id`, `occurredAt`, `actor`, `action`, `patientId`, `entityType`, `entityId`, `source`, `details`). Optional query: `since`, `until` (ISO timestamps), `action`, `limit` (1 to 5000, default 1000). The call itself is one EXPORT audit row with a count.

`pnpm audit:export` prints the same NDJSON from the host. It does not check the auditor token. Run it only where the database is already trusted.

## Rate limits

In-process fixed windows: 20 transfer POSTs, 60 transfer GETs, and 30 audit exports per minute, per token. Unsigned demo traffic shares one bucket. A second server does not share these counters. A 429 includes `retry-after`. Reconcile writes use the same kind of window (30 per minute) and redirect back with an error.

## Errors

API failures return a fixed sentence (`transfer failed`, `audit export failed`). The server logs the error name, not the message. The app error page shows a reference digest when Next provides one, not the exception text. Reconcile forms redirect with a short reason instead of throwing a parse error.

## HTTP

Responses send `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a Permissions-Policy that turns off camera, microphone, and geolocation. There is no `X-Frame-Options: DENY`. Epic launches this app inside the EHR frame. `poweredByHeader` is off.

## Epic review prep

Build against the free sandbox. Production listing (Showroom, formerly App Orchard) is not started. Before any real patient data: a BAA with every vendor that would see it, including Anthropic if `ANTHROPIC_API_KEY` is set, disk encryption, all three tokens, and `MEDISYNC_DATA_KEY`. Write-back to Epic is not implemented. Accept, reject, and edit store a decision. They do not write the chart.
