# Synthetic clinical encounters dataset (CUI-safe / no-PHI)

A fabricated healthcare encounter set for HIPAA-regulated and pharma workshops
(Commercial CoE). Used as a Day-3 alternate workload.

!!! warning "No PHI — synthetic by construction"
    Every patient, encounter, provider, and diagnosis is machine-generated.
    **No real patient data, MRNs, or PHI are present.** Patient IDs are obviously
    synthetic (`PT-…`) and do not map to any real individual. This dataset is
    safe under HIPAA because it contains **no protected health information** — it
    is fabricated for instruction only.

## Files

| File | Purpose | Rows (workshop size) |
|---|---|---|
| `encounters.csv` | Encounter fact (Bronze source) | ~30,000 |
| `patients.csv` | Synthetic patient dimension | ~5,000 |
| `providers.csv` | Provider dimension | ~150 |

## Schema — `encounters`

| Column | Type | Notes |
|---|---|---|
| `encounter_id` | string (UUID) | Synthetic surrogate key |
| `patient_id` | string | FK → `patients.patient_id` (e.g., `PT-024189`) |
| `provider_id` | string | FK → `providers.provider_id` |
| `encounter_date` | date | Synthetic, spread across ~1 year |
| `encounter_type` | string | `inpatient` \| `outpatient` \| `emergency` \| `telehealth` |
| `primary_dx_code` | string | Synthetic ICD-10-like code (fabricated, not real coding) |
| `length_of_stay_days` | int | 0 for outpatient/telehealth |
| `readmission_30d` | boolean | Synthetic outcome label for the analytics lab |

## Schema — `patients`

| Column | Type | Notes |
|---|---|---|
| `patient_id` | string | PK (synthetic; not an MRN) |
| `age_band` | string | `0-17` \| `18-39` \| `40-64` \| `65+` (banded — never a DOB) |
| `sex` | string | Generic category |
| `region` | string | Generic label, never an address |

## Schema — `providers`

| Column | Type | Notes |
|---|---|---|
| `provider_id` | string | PK (synthetic; not an NPI) |
| `specialty` | string | e.g., `cardiology`, `family_medicine` |
| `facility` | string | Fabricated facility name |

## Sample rows — `encounters`

```csv
encounter_id,patient_id,provider_id,encounter_date,encounter_type,primary_dx_code,length_of_stay_days,readmission_30d
9a1b...,PT-024189,PRV-0042,2026-02-11,inpatient,SYN-I50,4,true
8b2c...,PT-024189,PRV-0042,2026-03-02,outpatient,SYN-I50,0,false
7c3d...,PT-031007,PRV-0118,2026-02-15,emergency,SYN-J18,1,false
```

!!! note "De-identification by design"
    Direct identifiers (names, MRNs, DOBs, addresses) are **absent** — not
    masked, absent. Age is banded; diagnosis codes are synthetic (`SYN-…`)
    prefixes, not real ICD-10. This keeps the dataset outside PHI scope entirely.

## Lab use

- **Day 3 (Transform, healthcare alternate):** Bronze → Silver conforms encounter
  types; Silver → Gold builds `gold.readmission_rate_by_specialty` (a common
  quality metric) using the synthetic `readmission_30d` label.
- **Day 4 (Data Agent):** ground an agent on the Gold quality tables for
  questions like "which specialty had the highest 30-day readmission rate".

## Related

- [Datasets index](index.md) · [Day 3 — Transform](../5-day-commercial-coe/day-3-transform.md)
- [Healthcare clinical example](../../examples/healthcare-clinical.md)
