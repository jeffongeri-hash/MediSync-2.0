# Mapping coverage report

Generated 2026-10-10T17:54:02.250Z by mapping phase2.0. Synthetic data only.

- Coded resources: 5780; primary code mapped: 5780 (100.0%); unmapped: 0; no code: 0
- Distinct primary codes: 259
- SNOMED CT Conditions with an ICD-10-CM code: 225 of 405 rows (55.6%); no ICD-10-CM code applies: 135; not in the crosswalk: 45
- Distinct mapped SNOMED CT Condition concepts: 52; 37 with an ICD-10-CM code, 6 where none applies, 9 not in the crosswalk
- Review queue (mapping and dedupe, OPEN): 180 issues
- Gate: unmapped findings missing from the review queue: 0 (pass)

Terminology tables are local and unverified against official releases (NLM hosts are blocked). The code tables were
curated from the fixtures' own codes, so primary-code coverage of these fixtures is complete by construction; the
informative numbers are the ICD-10-CM crosswalk, units, medicationReference resolution and dedupe. New sources with
codes outside the tables land in the review queue below.

## Coverage by resource type

| Resource type | Rows | Mapped | Unmapped | No code | % mapped | Distinct codes | % Bundle | % NDJSON | % C-CDA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AllergyIntolerance | 51 | 51 | 0 | 0 | 100.0% | 10 | 100.0% | 100.0% | 100.0% |
| Condition | 405 | 405 | 0 | 0 | 100.0% | 52 | 100.0% | 100.0% | 100.0% |
| DocumentReference | 384 | 384 | 0 | 0 | 100.0% | 1 | 100.0% | 100.0% | – |
| Encounter | 576 | 576 | 0 | 0 | 100.0% | 14 | 100.0% | 100.0% | 100.0% |
| Immunization | 192 | 192 | 0 | 0 | 100.0% | 16 | 100.0% | 100.0% | 100.0% |
| Medication | 18 | 18 | 0 | 0 | 100.0% | 2 | 100.0% | 100.0% | – |
| MedicationRequest | 224 | 224 | 0 | 0 | 100.0% | 29 | 100.0% | 100.0% | – |
| MedicationStatement | 112 | 112 | 0 | 0 | 100.0% | 29 | – | – | 100.0% |
| Observation | 2420 | 2420 | 0 | 0 | 100.0% | 90 | 100.0% | 100.0% | 100.0% |
| Procedure | 1398 | 1398 | 0 | 0 | 100.0% | 47 | 100.0% | 100.0% | 100.0% |

## Coverage by code system (primary code)

| Code system | Resource types | Rows | Mapped | % mapped | Distinct codes |
| --- | --- | --- | --- | --- | --- |
| CVX | Immunization | 192 | 192 | 100.0% | 16 |
| LOINC | DocumentReference, Observation | 2804 | 2804 | 100.0% | 91 |
| RxNorm | AllergyIntolerance, Medication, MedicationRequest, MedicationStatement | 357 | 357 | 100.0% | 30 |
| SNOMED CT | AllergyIntolerance, Condition, Encounter, Procedure | 2427 | 2427 | 100.0% | 122 |

## Derived codes and units by format

| Format | SNOMED CT Conditions | With ICD-10-CM | Derived by crosswalk | Observation quantities | UCUM | % UCUM |
| --- | --- | --- | --- | --- | --- | --- |
| Bundle | 135 | 75 | 75 | 824 | 824 | 100.0% |
| NDJSON | 135 | 75 | 75 | 824 | 824 | 100.0% |
| C-CDA | 135 | 75 | 75 | 689 | 689 | 100.0% |

## Dedupe (cross-format links; rows are linked, never merged)

| Format | Rows | Primary | Linked by id | Linked by code + day |
| --- | --- | --- | --- | --- |
| Bundle | 2040 | 2040 | 0 | 0 |
| NDJSON | 2040 | 0 | 2040 | 0 |
| C-CDA | 1730 | 0 | 1730 | 0 |
| All | 5810 | 2040 | 3770 | 0 |

## Review queue (mapping and dedupe stages)

| Stage | Severity | Code | Rows | Open | Distinct codes | Example |
| --- | --- | --- | --- | --- | --- | --- |
| MAPPING | INFO | `no_target_code` | 135 | 135 | 6 | SNOMED CT concept is a social or administrative finding with no ICD-10-CM code |
| MAPPING | WARNING | `unmapped_code` | 45 | 45 | 9 | SNOMED CT concept is not in the ICD-10-CM crosswalk |

## Unmapped codes (every one is in the review queue)

| Resource type | System | Code | Display | Formats | Rows | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| Condition | SNOMED CT | `423315002` | Limited social contact (finding) | Bundle, NDJSON, C-CDA | 9 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `278602001` | Loose dental filling (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `224295006` | Only received primary school education (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `424393004` | Reports of violence in the environment (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `160968000` | Risk activity involvement (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `1187604002` | Serving in military service (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `422650009` | Social isolation (finding) | Bundle, NDJSON, C-CDA | 15 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `10939881000119105` | Unhealthy alcohol drinking behavior (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |
| Condition | SNOMED CT | `706893006` | Victim of intimate partner abuse (finding) | Bundle, NDJSON, C-CDA | 3 | not in ICD-10-CM crosswalk |

## Concepts with no ICD-10-CM code (INFO, in the review queue)

| Resource type | System | Code | Display | Formats | Rows |
| --- | --- | --- | --- | --- | --- |
| Condition | SNOMED CT | `473461003` | Educated to high school level (finding) | Bundle, NDJSON, C-CDA | 9 |
| Condition | SNOMED CT | `160903007` | Full-time employment (finding) | Bundle, NDJSON, C-CDA | 30 |
| Condition | SNOMED CT | `314529007` | Medication review due (situation) | Bundle, NDJSON, C-CDA | 69 |
| Condition | SNOMED CT | `741062008` | Not in labor force (finding) | Bundle, NDJSON, C-CDA | 9 |
| Condition | SNOMED CT | `160904001` | Part-time employment (finding) | Bundle, NDJSON, C-CDA | 9 |
| Condition | SNOMED CT | `224299000` | Received higher education (finding) | Bundle, NDJSON, C-CDA | 9 |
