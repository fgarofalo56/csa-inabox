{{ config(
    materialized='incremental',
    unique_key='encounter_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'encounters', 'clinical', 'hipaa', 'data_sovereignty'],
    on_schema_change='fail'
) }}

/*
    Silver Layer — Cleaned Clinical Encounters

    Transforms raw encounter records with:
    - ICD-10 code validation and categorization into clinical domains
      (diabetes, behavioral_health, maternal_child, etc.)
    - Diagnosis category assignment for Gold-layer analytics
    - Cost estimation based on encounter type and diagnosis
    - Tribal affiliation join for data sovereignty enforcement

    Row-Level Security: Filtered by tribal_affiliation from patient join.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_encounters') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Join to patient demographics for tribal affiliation and service unit
patient_lookup AS (
    SELECT
        patient_id,
        tribal_affiliation,
        service_unit,
        age_group,
        gender,
        eligibility_status
    FROM {{ ref('slv_patient_demographics') }}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            e.encounter_id,
            e.patient_id,
            CAST(e.encounter_date AS STRING)
        )) AS encounter_sk,

        -- Encounter identifiers
        e.encounter_id,
        e.patient_id,
        e.facility_id,

        -- Timing
        e.encounter_date,
        YEAR(e.encounter_date) AS encounter_year,
        QUARTER(e.encounter_date) AS encounter_quarter,
        CONCAT(CAST(YEAR(e.encounter_date) AS STRING), '-Q',
               CAST(QUARTER(e.encounter_date) AS STRING)) AS reporting_period,

        -- Encounter classification
        e.encounter_type,

        -- Primary diagnosis with ICD-10 validation
        e.primary_dx_icd10,
        LEFT(e.primary_dx_icd10, 3) AS dx_category_code,

        -- Diagnosis domain categorization for analytics
        CASE
            -- Diabetes (E11.x Type 2, E13.x Other specified)
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('E11', 'E13') THEN 'DIABETES'
            -- Substance use disorders (F10-F19)
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('F10', 'F11', 'F12', 'F13', 'F14',
                                                    'F15', 'F16', 'F17', 'F18', 'F19') THEN 'SUBSTANCE_USE'
            -- Mental health (F20-F48)
            WHEN LEFT(e.primary_dx_icd10, 3) BETWEEN 'F20' AND 'F48' THEN 'MENTAL_HEALTH'
            -- Combined behavioral health category
            WHEN LEFT(e.primary_dx_icd10, 3) BETWEEN 'F10' AND 'F48' THEN 'BEHAVIORAL_HEALTH'
            -- Maternal/pregnancy (O00-O9A, Z34, Z36, Z3A)
            WHEN LEFT(e.primary_dx_icd10, 1) = 'O' THEN 'MATERNAL'
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('Z34', 'Z36', 'Z3A') THEN 'MATERNAL'
            -- Well-child / preventive (Z00, Z01, Z02, Z23)
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('Z00', 'Z01', 'Z02', 'Z23') THEN 'PREVENTIVE'
            -- Respiratory
            WHEN LEFT(e.primary_dx_icd10, 1) = 'J' THEN 'RESPIRATORY'
            -- Cardiovascular
            WHEN LEFT(e.primary_dx_icd10, 1) = 'I' THEN 'CARDIOVASCULAR'
            -- Injury / external causes
            WHEN LEFT(e.primary_dx_icd10, 1) IN ('S', 'T') THEN 'INJURY'
            ELSE 'OTHER'
        END AS diagnosis_category,

        -- Behavioral health flag (SUD + mental health combined)
        CASE
            WHEN LEFT(e.primary_dx_icd10, 3) BETWEEN 'F10' AND 'F48' THEN TRUE
            ELSE FALSE
        END AS is_behavioral_health,

        -- Substance use disorder flag (42 CFR Part 2 protected)
        CASE
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('F10', 'F11', 'F12', 'F13', 'F14',
                                                    'F15', 'F16', 'F17', 'F18', 'F19') THEN TRUE
            ELSE FALSE
        END AS is_sud_protected,

        -- Maternal/child health flag
        CASE
            WHEN LEFT(e.primary_dx_icd10, 1) = 'O' THEN TRUE
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('Z34', 'Z36', 'Z3A') THEN TRUE
            WHEN LEFT(e.primary_dx_icd10, 3) IN ('Z00', 'Z23') AND p.age_group IN ('0-4', '5-9', '10-14') THEN TRUE
            ELSE FALSE
        END AS is_maternal_child,

        -- Secondary diagnoses
        e.secondary_dx_codes,

        -- Provider information
        e.provider_type,

        -- Encounter outcome
        e.disposition,

        -- Cost estimation based on encounter type
        -- (Synthetic estimates based on IHS cost report averages)
        CASE
            WHEN e.encounter_type = 'INPATIENT' THEN 12500.00
            WHEN e.encounter_type = 'ED' THEN 3200.00
            WHEN e.encounter_type = 'OUTPATIENT' THEN 450.00
            WHEN e.encounter_type = 'TELEHEALTH' THEN 175.00
            ELSE 400.00
        END AS estimated_cost,

        -- Patient context from demographics
        p.tribal_affiliation,
        p.service_unit,
        p.age_group,
        p.gender,
        p.eligibility_status,

        -- Data quality
        CASE
            WHEN e.primary_dx_icd10 IS NOT NULL
                 AND LENGTH(e.primary_dx_icd10) >= 3
                 AND p.tribal_affiliation IS NOT NULL
            THEN TRUE
            ELSE FALSE
        END AS is_valid,

        -- Metadata
        e.source_system,
        e.ingestion_timestamp,
        e.record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base e
    LEFT JOIN patient_lookup p ON e.patient_id = p.patient_id
)

SELECT * FROM standardized
WHERE is_valid = TRUE
