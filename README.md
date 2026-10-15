# MediSync

A SMART on FHIR app for Epic that transfers patient records between EHRs and reconciles outside records
(meds, problems, allergies, PMH), with AI suggestions a provider must accept. **Synthetic data only.**

Status: Phases 0 to 6 are built (Phase 6: hardening). The Phase 5 gate still waits on the Epic and Oracle Health
sandbox runs. See `docs/BUILD_PLAN.md`, and `docs/SECURITY.md` for the security checklist.

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

## Prepare for EHR review

Epic and Oracle Health both review an app before it can run against real patients. These steps get MediSync ready.
Facts about their programs are unverified: fhir.epic.com and the Oracle Health hosts were blocked from the build
container (`docs/NOTES.md`). Check each one on their sites.

1. Finish the Phase 5 sandbox runs in `docs/EPIC_SANDBOX.md` and `docs/ORACLE_SANDBOX.md`, and commit the write-back
   reports they produce. Reviewers ask what an app reads and writes, and the reports answer the write half.
2. Collect the registration facts a reviewer asks for:
   - Launch URL `https://<host>/smart/launch` and redirect URI `https://<host>/smart/callback`. MediSync is a public
     client and requires PKCE S256.
   - Scopes: `launch` (or `launch/patient`), `openid fhirUser`, and `patient/<Type>.read` for Patient, Condition,
     MedicationRequest, Medication, AllergyIntolerance and Encounter. MediSync asks for no write scope and no
     `offline_access`.
   - Data handling: the chart read at launch is stored as received (encrypted) with a canonical copy, every read and
     write is audited, and nothing is written to the EHR. Write-back is a dry run that a provider downloads.
3. Set the production settings. `.env.example` explains each one.

   | Variable | Production value |
   | --- | --- |
   | `DEMO_MODE` | `0` or unset, so the seeded demo patients are closed |
   | `DATA_KEYS`, `DATA_KEY_ID` | data keys from your secret manager; without them, ingest refuses to store records |
   | `SESSION_SECRET` | 32 or more random bytes |
   | `TRUST_PROXY` | `1` behind a load balancer that sets `X-Forwarded-For` |
   | `SMART_<NAME>_FRAME_ANCESTORS` | the EHR origins allowed to frame the app (default: the origin of its iss) |
   | `SESSION_COOKIE_SAMESITE` | `none` only if an EHR opens the app in a cross-site iframe |

4. Grant roles. Each SMART user is a provider (Practitioner) or a viewer by default. To let someone export the
   audit log, run `pnpm roles list` and then `pnpm roles grant smart:<fhirUser> admin`.
5. Gather the evidence: `docs/SECURITY.md`, a verified audit export (`pnpm audit:export --out audit.ndjson`), and a
   green CI run (unit, database, browser and accessibility tests).
6. Close the deferred items in `docs/SECURITY.md` that a reviewer asks about first: the BAA and HIPAA work (38),
   key management (16), database encryption and TLS (14), and a penetration test (39).
7. Submit. For Epic, the path is an Epic on FHIR app registration, then a Showroom listing with Epic's vendor review.
   For Oracle Health, start from the app registered in its code console. Both paths are unverified.

## Claude skills
Project skills live in `.claude/skills/`. Claude Code loads each `<name>/SKILL.md`.

- **apple-design** — `.claude/skills/apple-design/` ([emilkowalski/skills](https://github.com/emilkowalski/skills))
- **ponytail** — `.claude/skills/ponytail/`, plus `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, and `ponytail-help` ([DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail))
- **pstack** — `.claude/skills/pstack/<skill>/`, with a link at `.claude/skills/<skill>/` so Claude Code discovers each skill ([michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude))
- **Anthropic example skills** — `.claude/skills/<name>/` for the Apache-2.0 example-skills set ([anthropics/skills](https://github.com/anthropics/skills)): algorithmic-art, brand-guidelines, canvas-design, doc-coauthoring, frontend-design, internal-comms, mcp-builder, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing

The document skills (`docx`, `pdf`, `pptx`, `xlsx`) are not in this tree. Their upstream LICENSE.txt forbids copying them outside Anthropic services and distributing those copies.
