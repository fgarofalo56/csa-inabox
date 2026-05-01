-- ==========================================================================
-- Gold Report: 30-Day Readmission Risk Scores
-- Produces a per-patient readmission risk score using a weighted composite
-- of diagnosis complexity, prior utilization, length of stay, and age risk.
-- All data is synthetic — no real PHI.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH encounters AS (
    SELECT * FROM {{ ref('fct_encounters') }}
    WHERE encounter_type = 'Inpatient'
      AND discharge_date >= DATEADD(MONTH, -12, CURRENT_DATE())
),

patients AS (
    SELECT * FROM {{ ref('dim_patients') }}
),

diagnoses AS (
    SELECT * FROM {{ ref('dim_diagnoses') }}
),

-- Per-encounter diagnosis complexity
encounter_dx_complexity AS (
    SELECT
        encounter_id,
        COUNT(DISTINCT icd10_code)                  AS diagnosis_count,
        COUNT(DISTINCT ccs_category)                AS distinct_ccs_categories,
        MAX(CASE WHEN ccs_category IN (
            'Heart Failure', 'COPD', 'Type 2 Diabetes',
            'Kidney Disease', 'Cerebral Infarction'
        ) THEN 1 ELSE 0 END)                        AS has_high_risk_condition
    FROM diagnoses
    GROUP BY encounter_id
),

-- Build risk score per patient's most recent encounter
scored AS (
    SELECT
        e.encounter_id,
        e.patient_id,
        e.facility,
        e.admit_date,
        e.discharge_date,
        e.length_of_stay_days,
        e.drg_code,
        e.is_30day_readmission,
        p.age_group,
        p.age_risk_tier,
        p.is_chronic_complex,
        p.inpatient_count,

        dx.diagnosis_count,
        dx.distinct_ccs_categories,
        dx.has_high_risk_condition,

        -- Composite risk score (0-100 scale)
        ROUND(
            -- Age component (0-25)
            (CASE p.age_risk_tier
                WHEN 'Critical'  THEN 25
                WHEN 'High'      THEN 20
                WHEN 'Elevated'  THEN 15
                WHEN 'Moderate'  THEN 10
                ELSE 5
            END)
            -- Diagnosis complexity component (0-25)
            + LEAST(COALESCE(dx.diagnosis_count, 0) * 3, 25)
            -- Prior utilization component (0-25)
            + LEAST(COALESCE(p.inpatient_count, 0) * 5, 25)
            -- LOS component (0-15): longer stays = higher risk
            + LEAST(COALESCE(e.length_of_stay_days, 0) * 2, 15)
            -- High-risk condition flag (0-10)
            + COALESCE(dx.has_high_risk_condition, 0) * 10
        , 1)                                        AS readmission_risk_score,

        -- Risk tier
        CASE
            WHEN (
                CASE p.age_risk_tier
                    WHEN 'Critical' THEN 25 WHEN 'High' THEN 20
                    WHEN 'Elevated' THEN 15 WHEN 'Moderate' THEN 10 ELSE 5
                END
                + LEAST(COALESCE(dx.diagnosis_count, 0) * 3, 25)
                + LEAST(COALESCE(p.inpatient_count, 0) * 5, 25)
                + LEAST(COALESCE(e.length_of_stay_days, 0) * 2, 15)
                + COALESCE(dx.has_high_risk_condition, 0) * 10
            ) >= 70 THEN 'Critical'
            WHEN (
                CASE p.age_risk_tier
                    WHEN 'Critical' THEN 25 WHEN 'High' THEN 20
                    WHEN 'Elevated' THEN 15 WHEN 'Moderate' THEN 10 ELSE 5
                END
                + LEAST(COALESCE(dx.diagnosis_count, 0) * 3, 25)
                + LEAST(COALESCE(p.inpatient_count, 0) * 5, 25)
                + LEAST(COALESCE(e.length_of_stay_days, 0) * 2, 15)
                + COALESCE(dx.has_high_risk_condition, 0) * 10
            ) >= 50 THEN 'High'
            WHEN (
                CASE p.age_risk_tier
                    WHEN 'Critical' THEN 25 WHEN 'High' THEN 20
                    WHEN 'Elevated' THEN 15 WHEN 'Moderate' THEN 10 ELSE 5
                END
                + LEAST(COALESCE(dx.diagnosis_count, 0) * 3, 25)
                + LEAST(COALESCE(p.inpatient_count, 0) * 5, 25)
                + LEAST(COALESCE(e.length_of_stay_days, 0) * 2, 15)
                + COALESCE(dx.has_high_risk_condition, 0) * 10
            ) >= 30 THEN 'Moderate'
            ELSE 'Low'
        END                                         AS risk_tier,

        -- Top risk factors (descriptive)
        CONCAT_WS(', ',
            CASE WHEN p.age_risk_tier IN ('Critical', 'High')
                 THEN 'Advanced age' END,
            CASE WHEN COALESCE(dx.has_high_risk_condition, 0) = 1
                 THEN 'High-risk condition' END,
            CASE WHEN COALESCE(p.inpatient_count, 0) >= 3
                 THEN 'Frequent admissions' END,
            CASE WHEN COALESCE(e.length_of_stay_days, 0) >= 7
                 THEN 'Extended LOS' END,
            CASE WHEN p.is_chronic_complex
                 THEN 'Chronic complexity' END
        )                                           AS top_risk_factors,

        CURRENT_TIMESTAMP()                         AS scored_at

    FROM encounters e
    LEFT JOIN patients p
        ON e.patient_id = p.patient_id
    LEFT JOIN encounter_dx_complexity dx
        ON e.encounter_id = dx.encounter_id
)

SELECT * FROM scored
