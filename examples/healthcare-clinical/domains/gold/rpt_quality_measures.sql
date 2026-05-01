-- ==========================================================================
-- Gold Report: CMS Quality Measures
-- Calculates readmission rates by condition category for quality
-- reporting and value-based purchasing programs.
-- All data is synthetic — no real PHI.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH encounters AS (
    SELECT * FROM {{ ref('fct_encounters') }}
    WHERE encounter_type = 'Inpatient'
),

diagnoses AS (
    SELECT * FROM {{ ref('dim_diagnoses') }}
    WHERE is_primary_diagnosis = TRUE
),

-- Join encounters with primary diagnosis to get condition category
encounter_conditions AS (
    SELECT
        e.encounter_id,
        e.patient_id,
        e.facility,
        e.admit_date,
        e.discharge_date,
        e.length_of_stay_days,
        e.is_30day_readmission,
        d.ccs_category                              AS condition_category,
        d.clinical_domain,
        -- Rolling 12-month period label
        DATE_FORMAT(e.discharge_date, 'yyyy-MM')    AS measure_period
    FROM encounters e
    INNER JOIN diagnoses d
        ON e.encounter_id = d.encounter_id
),

-- Readmission rates by condition and period
condition_rates AS (
    SELECT
        condition_category,
        clinical_domain,
        measure_period,
        facility,
        COUNT(DISTINCT encounter_id)                AS total_discharges,
        SUM(CASE WHEN is_30day_readmission THEN 1 ELSE 0 END)
                                                    AS readmissions,
        ROUND(
            SUM(CASE WHEN is_30day_readmission THEN 1 ELSE 0 END) * 100.0 /
            NULLIF(COUNT(DISTINCT encounter_id), 0),
            2
        )                                           AS readmission_rate,
        ROUND(AVG(length_of_stay_days), 1)          AS avg_los_days,
        COUNT(DISTINCT patient_id)                  AS unique_patients
    FROM encounter_conditions
    GROUP BY condition_category, clinical_domain, measure_period, facility
),

-- National benchmarks (representative, not actual CMS values)
benchmarks AS (
    SELECT 'Heart Failure'              AS condition_category, 21.9 AS national_benchmark UNION ALL
    SELECT 'COPD',                                               19.7 UNION ALL
    SELECT 'Pneumonia',                                          17.3 UNION ALL
    SELECT 'Acute Myocardial Infarction',                        15.5 UNION ALL
    SELECT 'Type 2 Diabetes',                                    14.8 UNION ALL
    SELECT 'Kidney Disease',                                     22.5 UNION ALL
    SELECT 'Cerebral Infarction',                                12.8 UNION ALL
    SELECT 'Hip Fracture',                                       16.2 UNION ALL
    SELECT 'Other',                                              14.0
)

SELECT
    cr.condition_category,
    cr.clinical_domain,
    cr.measure_period,
    cr.facility,
    cr.total_discharges,
    cr.readmissions,
    cr.readmission_rate,
    cr.avg_los_days,
    cr.unique_patients,
    COALESCE(b.national_benchmark, 14.0)            AS national_benchmark,
    ROUND(cr.readmission_rate - COALESCE(b.national_benchmark, 14.0), 2)
                                                    AS benchmark_variance,
    CASE
        WHEN cr.readmission_rate > COALESCE(b.national_benchmark, 14.0) + 2
            THEN 'Worse Than Expected'
        WHEN cr.readmission_rate < COALESCE(b.national_benchmark, 14.0) - 2
            THEN 'Better Than Expected'
        ELSE 'No Different Than Expected'
    END                                             AS benchmark_status,
    CURRENT_TIMESTAMP()                             AS calculated_at

FROM condition_rates cr
LEFT JOIN benchmarks b
    ON cr.condition_category = b.condition_category
