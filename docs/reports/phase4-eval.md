# Phase 4 gate: reconciliation eval

Gate: eval pass rate over 20 synthetic cases, where every AI claim has a valid source id and no condition is hallucinated.

## Result

- **Claude pass rate: not available yet. 0 of 20 cases evaluated.** No `ANTHROPIC_API_KEY` is configured in this environment,
  so no response has been recorded (`fixtures/eval/recordings/` is empty) and replay reports every case as not evaluated.
  See "When the key is set" below. Estimated cost per full live run: about 76k input tokens plus output across 20 calls to
  claude-sonnet-5-5.
- **Harness check (no AI): 20/20.** The rule-built template answers every case with claims in the records' own words, so it
  passes by construction. It shows the cases, citation check and condition check run end to end. It is not a model result.
- **Scorer check:** unit tests feed an adversarial responder (unknown ids, missing citations, an invented "Type 2 diabetes") and
  every such case fails (`src/ai/eval.test.ts`).
- **Rules:** every rule-detectable injected change was caught: dose change 5/5, status flip 5/5, allergy vs active medication 3/3.
  The 6 reworded duplicates under a local code are left to AI flags by design (rules 0/6). No decoy was named.

## When the key is set

1. `pnpm eval --prompts /tmp/prompts` (optional): writes the exact prompts for review; nothing is sent.
2. `pnpm eval --live --cases case-01`: one call, a cheap check that the API accepts the request (structured output, streaming,
   refusal fallback). A rejected request shows as `bad_request: <API message>` in the report.
3. `pnpm eval --live --out docs/reports/phase4-eval-claude.md`: all 20 cases; recordings land in `fixtures/eval/recordings/`.
4. Commit the recordings and the report. CI replays them on every push (report-only); `pnpm eval --strict` gates locally.

## Eval set

10 seeded Synthea patients (cases 1-10 as received) and the same 10 with 2 or 3 injected changes each (cases 11-20,
25 changes): dose change, status flip, allergy against an active medication, a duplicate reworded under a local code, and a
near-miss decoy condition (prediabetes, acute bronchitis or viral sinusitis, where a claim must not name diabetes, COPD or
chronic sinusitis). Current chart = Bundle primaries as of 12 months before the latest encounter; incoming = the C-CDA.
Frozen in `fixtures/eval` (`pnpm eval:build` rebuilds it identically from a seeded database).

A case passes when the output parses, has at least one claim, and every claim cites at least one record, cites only ids that
were sent, and names no condition that is absent from its cited rows (miscited) or from all rows (hallucinated).

## Replay run (recorded Claude responses)

Responder: replay · prompt reconcile-summary@1 · 2026-10-11T05:18:23.237Z

**Pass rate: 0/0 evaluated (n/a); 20 of 20 not evaluated.**

## Template run (no AI, harness check)

Responder: template · prompt reconcile-summary@1 · 2026-10-11T05:18:24.584Z

**Pass rate: 20/20 evaluated (100.0%); 0 of 20 not evaluated.**

| Check | Result |
| --- | --- |
| Claims valid | 317/317 (100.0%) |
| Citations to ids not in the input | 0 of 591 |
| Claims with no citation | 0 |
| Hallucinated conditions (in no record) | 0 |
| Miscited conditions (in a record the claim does not cite) | 0 |

### Injected changes

| Type | Cases | Caught by rules | Caught by AI flags | Decoy named |
| --- | --- | --- | --- | --- |
| dose_change | 5 | 5 | 0 | n/a |
| status_flip | 5 | 5 | 0 | n/a |
| recoded_duplicate | 6 | 0 | 0 | n/a |
| allergy_med | 3 | 3 | 0 | n/a |
| decoy | 6 | n/a | n/a | 0 |

### Cases

| Case | Patient | Injected | Status | Claims valid | Problems |
| --- | --- | --- | --- | --- | --- |
| case-01 | p01 | none | pass | 17/17 | none |
| case-02 | p02 | none | pass | 3/3 | none |
| case-03 | p03 | none | pass | 15/15 | none |
| case-04 | p04 | none | pass | 19/19 | none |
| case-05 | p05 | none | pass | 19/19 | none |
| case-06 | p06 | none | pass | 11/11 | none |
| case-07 | p07 | none | pass | 14/14 | none |
| case-08 | p08 | none | pass | 26/26 | none |
| case-09 | p09 | none | pass | 21/21 | none |
| case-10 | p10 | none | pass | 5/5 | none |
| case-11 | p01 | dose_change, status_flip, recoded_duplicate | pass | 18/18 | none |
| case-12 | p02 | allergy_med, decoy | pass | 6/6 | none |
| case-13 | p03 | recoded_duplicate, decoy, dose_change | pass | 17/17 | none |
| case-14 | p04 | recoded_duplicate, decoy | pass | 21/21 | none |
| case-15 | p05 | decoy, dose_change, status_flip | pass | 20/20 | none |
| case-16 | p06 | dose_change, status_flip | pass | 11/11 | none |
| case-17 | p07 | status_flip, allergy_med, recoded_duplicate | pass | 17/17 | none |
| case-18 | p08 | allergy_med, recoded_duplicate | pass | 28/28 | none |
| case-19 | p09 | recoded_duplicate, decoy, dose_change | pass | 23/23 | none |
| case-20 | p10 | decoy, status_flip | pass | 6/6 | none |
