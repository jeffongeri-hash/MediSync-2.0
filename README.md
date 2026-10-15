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

## Claude skills
Project skills live in `.claude/skills/`. Claude Code loads each `<name>/SKILL.md`.

- **apple-design** — `.claude/skills/apple-design/` ([emilkowalski/skills](https://github.com/emilkowalski/skills))
- **ponytail** — `.claude/skills/ponytail/`, plus `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, and `ponytail-help` ([DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail))
- **pstack** — `.claude/skills/pstack/<skill>/`, with a link at `.claude/skills/<skill>/` so Claude Code discovers each skill ([michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude))
- **Anthropic example skills** — `.claude/skills/<name>/` for the Apache-2.0 example-skills set ([anthropics/skills](https://github.com/anthropics/skills)): algorithmic-art, brand-guidelines, canvas-design, doc-coauthoring, frontend-design, internal-comms, mcp-builder, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing

The document skills (`docx`, `pdf`, `pptx`, `xlsx`) are not in this tree. Their upstream LICENSE.txt forbids copying them outside Anthropic services and distributing those copies.
