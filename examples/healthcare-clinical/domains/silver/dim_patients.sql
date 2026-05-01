-- ==========================================================================
-- Dimension Model: Patients
-- De-identified patient demographics with derived risk factors.
-- All data is synthetic — no real PHI. Age is represented as age_group
-- and ZIP is truncated to 3-digit prefix per HIPAA Safe Harbor.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_patients') }}
),

-- Count encounters and diagnoses per patient for risk stratification
patient_history AS (
    SELECT
        e.patient_id,
        COUNT(DISTINCT e.encounter_id)              AS total_encounters,
        COUNT(DISTINCT CASE
            WHEN e.encounter_type = 'Inpatient'
            THEN e.encounter_id
        END)                                        AS inpatient_count,
        COUNT(DISTINCT d.icd10_code)                AS distinct_diagnosis_count,
        MAX(e.discharge_date)                       AS last_discharge_date
    FROM {{ ref('stg_encounters') }} e
    LEFT JOIN {{ ref('stg_diagnoses') }} d
        ON e.encounter_id = d.encounter_id
    GROUP BY e.patient_id
),

enriched AS (
    SELECT
        p.patient_id,
        p.age_group,
        p.gender,
        p.zip_3,
        p.race_ethnicity,
        p.primary_language,
        p.insurance_type,

        COALESCE(h.total_encounters, 0)             AS total_encounters,
        COALESCE(h.inpatient_count, 0)              AS inpatient_count,
        COALESCE(h.distinct_diagnosis_count, 0)     AS distinct_diagnosis_count,
        h.last_discharge_date,

        -- Age-based risk tier
        CASE p.age_group
            WHEN '85+'    THEN 'Critical'
            WHEN '75-84'  THEN 'High'
            WHEN '65-74'  THEN 'Elevated'
            WHEN '50-64'  THEN 'Moderate'
            ELSE 'Standard'
        END                                         AS age_risk_tier,

        -- Flag patients with >= 5 distinct diagnoses as chronic-complex
        CASE
            WHEN COALESCE(h.distinct_diagnosis_count, 0) >= 5
            THEN TRUE
            ELSE FALSE
        END                                         AS is_chronic_complex,

        CURRENT_TIMESTAMP()                         AS updated_at

    FROM staged p
    LEFT JOIN patient_history h
        ON p.patient_id = h.patient_id
)

SELECT * FROM enriched
