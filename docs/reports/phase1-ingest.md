# Ingest issue report

Generated 2026-10-10T07:26:54.268Z by parser phase1.1. Synthetic data only; patients are shown by source id prefix.

- Patients: 10; fully ingested in all three formats: 10
- Canonical resources: Bundle 2031, NDJSON 2031, C-CDA 1730
- Issue occurrences: ERROR 0, WARNING 81, INFO 3665

## Per patient

| Patient | Bundle resources | NDJSON resources | C-CDA resources | ERROR | WARNING | INFO |
| --- | --- | --- | --- | --- | --- | --- |
| `07a221aa` | 274 | 274 | 255 | 0 | 4 | 370 |
| `112ec6ef` | 91 | 91 | 76 | 0 | 0 | 134 |
| `122c8884` | 220 | 220 | 184 | 0 | 0 | 396 |
| `3a329aa5` | 102 | 102 | 87 | 0 | 0 | 128 |
| `5ea8f421` | 336 | 336 | 290 | 0 | 11 | 595 |
| `a90ab4e3` | 204 | 204 | 148 | 0 | 2 | 447 |
| `bb26934b` | 157 | 157 | 131 | 0 | 9 | 271 |
| `c4a5ef89` | 190 | 190 | 163 | 0 | 10 | 350 |
| `cfa8d860` | 194 | 194 | 158 | 0 | 5 | 368 |
| `f206cc3b` | 263 | 263 | 238 | 0 | 40 | 453 |

## By issue code

| Severity | Code | Format | Rows | Occurrences | Example |
| --- | --- | --- | --- | --- | --- |
| WARNING | `duplicate_in_source` | C-CDA | 46 | 46 | Observation id repeated with different content; first kept |
| WARNING | `invalid_value` | C-CDA | 35 | 35 | ST value is an unrendered template placeholder; omitted |
| INFO | `defaulted_field` | C-CDA | 10 | 192 | Encounter.class absent in C-CDA; set to v3-NullFlavor UNK |
| INFO | `timezone_assumed_utc` | C-CDA | 10 | 2111 | C-CDA timestamp without UTC offset; UTC assumed |
| INFO | `unsupported_resource` | C-CDA | 10 | 107 | C-CDA organizer (DiagnosticReport-like) not converted; member observations kept |
| INFO | `unsupported_resource` | Bundle | 93 | 1255 | CarePlan is outside the Phase 1 canonical scope; kept raw only |

## Sources not tied to one patient

| Source | Format | ERROR | WARNING | INFO |
| --- | --- | --- | --- | --- |
| `hospitalInformation1791587102495.json` | Bundle | 0 | 0 | 77 |
| `practitionerInformation1791587102495.json` | Bundle | 0 | 0 | 76 |
