# Transfer fidelity report

Patient `c4a5ef89-933c-c428-8fa7-4a26d9f621a9` from `synthea` → US Core 6.1.0 FHIR R4 transaction Bundle. **Export**: the bundle was produced and stored with the job. Export timestamp 2026-10-11T00:00:00.000Z.

## Summary

| Measure | Value |
|---|---|
| Completeness (source elements transferred) | **96.1%** (3,469 kept + 376 changed of 3,999) |
| Lost elements | 154 (3.9%) |
| Resources | 193 selected · 193 exported · 0 excluded |
| Provenance resources added | 193 |
| Bundle | 386 entries · 866 KiB · sha256 `c857c7e137de6a78a0448ae938477d6422e5b88ce982d9f41a7c2de9fc75bded` |
| Conformance (local US Core checks) | 0 errors · 11 warnings |
| Open review-queue entries from earlier stages | 53 |

## Findings

- **Lost**: 154 elements (references to types outside the canonical model: 154). Referenced types not sent: Location, Organization, Practitioner; their display text is kept.
- **Changed**: 376 elements (reference rewritten to the bundle entry: 376).
- **Excluded**: no resource fails a US Core mandatory check.
- **Not merged**: 9 element(s) exist only in a linked duplicate from another format (see below).

## By resource type

Completeness = (kept + changed) / source elements, counted on leaf elements of each source resource as received.

| Resource type | Selected | Exported | Excluded | Source elements | Kept | Changed | Lost | Added | Completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Patient | 1 | 1 | 0 | 83 | 83 | 0 | 0 | 0 | 100.0% |
| Medication | 3 | 3 | 0 | 15 | 15 | 0 | 0 | 0 | 100.0% |
| Encounter | 16 | 16 | 0 | 443 | 379 | 16 | 48 | 0 | 89.2% |
| Condition | 20 | 20 | 0 | 312 | 272 | 40 | 0 | 0 | 100.0% |
| AllergyIntolerance | 6 | 6 | 0 | 90 | 84 | 6 | 0 | 0 | 100.0% |
| MedicationRequest | 12 | 12 | 0 | 268 | 227 | 29 | 12 | 0 | 95.5% |
| Immunization | 7 | 7 | 0 | 77 | 56 | 14 | 7 | 0 | 90.9% |
| Procedure | 55 | 55 | 0 | 691 | 511 | 125 | 55 | 0 | 92.0% |
| Observation | 57 | 57 | 0 | 1,604 | 1,490 | 114 | 0 | 0 | 100.0% |
| DocumentReference | 16 | 16 | 0 | 416 | 352 | 32 | 32 | 0 | 92.3% |
| **All** | 193 | 193 | 0 | 3,999 | 3,469 | 376 | 154 | 0 | 96.1% |

## What would be lost

| Resource type | Element | Reason | Count |
|---|---|---|---:|
| Procedure | `location.reference` | reference to Location: type not in the canonical model (display kept) | 55 |
| DocumentReference | `author[].reference` | reference to Practitioner: type not in the canonical model (display kept) | 16 |
| DocumentReference | `custodian.reference` | reference to Organization: type not in the canonical model (display kept) | 16 |
| Encounter | `location[].location.reference` | reference to Location: type not in the canonical model (display kept) | 16 |
| Encounter | `participant[].individual.reference` | reference to Practitioner: type not in the canonical model (display kept) | 16 |
| Encounter | `serviceProvider.reference` | reference to Organization: type not in the canonical model (display kept) | 16 |
| MedicationRequest | `requester.reference` | reference to Practitioner: type not in the canonical model (display kept) | 12 |
| Immunization | `location.reference` | reference to Location: type not in the canonical model (display kept) | 7 |

## What would change

| Resource type | Element | Change | Count | Example |
|---|---|---|---:|---|
| Observation | `encounter.reference` | reference rewritten to the bundle entry | 57 | `Encounter/<id> -> urn:uuid:<entry>` |
| Observation | `subject.reference` | reference rewritten to the bundle entry | 57 | `Patient/<id> -> urn:uuid:<entry>` |
| Procedure | `encounter.reference` | reference rewritten to the bundle entry | 55 | `Encounter/<id> -> urn:uuid:<entry>` |
| Procedure | `subject.reference` | reference rewritten to the bundle entry | 55 | `Patient/<id> -> urn:uuid:<entry>` |
| Condition | `encounter.reference` | reference rewritten to the bundle entry | 20 | `Encounter/<id> -> urn:uuid:<entry>` |
| Condition | `subject.reference` | reference rewritten to the bundle entry | 20 | `Patient/<id> -> urn:uuid:<entry>` |
| DocumentReference | `context.encounter[].reference` | reference rewritten to the bundle entry | 16 | `Encounter/<id> -> urn:uuid:<entry>` |
| DocumentReference | `subject.reference` | reference rewritten to the bundle entry | 16 | `Patient/<id> -> urn:uuid:<entry>` |
| Encounter | `subject.reference` | reference rewritten to the bundle entry | 16 | `Patient/<id> -> urn:uuid:<entry>` |
| Procedure | `reasonReference[].reference` | reference rewritten to the bundle entry | 15 | `Condition/<id> -> urn:uuid:<entry>` |
| MedicationRequest | `encounter.reference` | reference rewritten to the bundle entry | 12 | `Encounter/<id> -> urn:uuid:<entry>` |
| MedicationRequest | `subject.reference` | reference rewritten to the bundle entry | 12 | `Patient/<id> -> urn:uuid:<entry>` |
| Immunization | `encounter.reference` | reference rewritten to the bundle entry | 7 | `Encounter/<id> -> urn:uuid:<entry>` |
| Immunization | `patient.reference` | reference rewritten to the bundle entry | 7 | `Patient/<id> -> urn:uuid:<entry>` |
| AllergyIntolerance | `patient.reference` | reference rewritten to the bundle entry | 6 | `Patient/<id> -> urn:uuid:<entry>` |
| MedicationRequest | `medicationReference.reference` | reference rewritten to the bundle entry | 3 | `Medication/<id> -> urn:uuid:<entry>` |
| MedicationRequest | `reasonReference[].reference` | reference rewritten to the bundle entry | 2 | `Condition/<id> -> urn:uuid:<entry>` |

## Added by the transfer

- 193 Provenance resources (one per exported resource: source system, MediSync as transmitter, source documents by sha256).

- Every exported resource declares its versioned US Core profile in `meta.profile`.

- 10 derived ICD-10-CM codings were withheld: the local SNOMED CT crosswalk is unverified, so derived codes are never sent.

- No elements were added to the clinical resources themselves.

## Available only in a linked duplicate (not exported)

Primary rows are exported; linked cross-format duplicates are cited in Provenance but never merged in. 356 duplicates are linked to the exported rows.

| Resource type | Duplicate format | Element | Rows |
|---|---|---|---:|
| AllergyIntolerance | CCDA | `onset[x]` | 6 |
| AllergyIntolerance | CCDA | `reaction[].severity` | 3 |

Duplicates of another resource type are not compared element by element:

| Primary type | Duplicate format | Duplicate type | Rows |
|---|---|---|---:|
| MedicationRequest | CCDA | MedicationStatement | 12 |

## Conformance (US Core 6.1.0, local checks)

| Profile | Resources |
|---|---:|
| `us-core-procedure` | 55 |
| `us-core-condition-encounter-diagnosis` | 20 |
| `us-core-documentreference` | 16 |
| `us-core-encounter` | 16 |
| `us-core-observation-screening-assessment` | 14 |
| `us-core-medicationrequest` | 12 |
| `us-core-observation-lab` | 11 |
| `us-core-immunization` | 7 |
| `us-core-allergyintolerance` | 6 |
| `us-core-blood-pressure` | 4 |
| `us-core-bmi` | 4 |
| `us-core-body-height` | 4 |
| `us-core-body-weight` | 4 |
| `us-core-heart-rate` | 4 |
| `us-core-respiratory-rate` | 4 |
| `us-core-smokingstatus` | 4 |
| `us-core-vital-signs` | 4 |
| `us-core-medication` | 3 |
| `us-core-patient` | 1 |

Excluded (a mandatory element is missing):

None.

Must-support elements absent (exported anyway):

| Resource type | Element | Resources |
|---|---|---:|
| Encounter | `reasonCode` or `reasonReference` | 7 |
| MedicationRequest | `dosageInstruction` | 4 |

## Open review-queue items (ingest, mapping, dedupe)

| Stage | Severity | Code | Count |
|---|---|---|---:|
| INGEST | INFO | `defaulted_field` | 1 |
| INGEST | INFO | `timezone_assumed_utc` | 1 |
| INGEST | INFO | `unsupported_resource` | 11 |
| INGEST | WARNING | `duplicate_in_source` | 10 |
| MAPPING | INFO | `no_target_code` | 21 |
| MAPPING | WARNING | `unmapped_code` | 9 |

## Caveats

- The US Core 6.1.0 profile choice, profile URLs and element rules are from memory: hl7.org is blocked by the network policy, so the IG was not checked (docs/NOTES.md). When unsure whether an element is mandatory, it is checked as must-support, so a table error can only cause a warning.

- Terminology tables and the SNOMED CT to ICD-10-CM crosswalk are unverified (Phase 2).

- `id`, `meta` and `resourceType` are not scored: entries are POSTs, so the target assigns ids; source ids and documents are in Provenance.
