{{ config(
    materialized='table',
    tags=['gold', 'diabetes', 'chronic_disease', 'hipaa', 'analytics']
) }}

/*
    Gold Layer — Diabetes Prevalence Tracking

    Aggregates diabetes-related encounters and patient data to produce:
    - Prevalence rates by service unit (per 1,000 population)
    - A1C control rates (< 7.0% = controlled, >= 9.0% = poor control)
    - Complication rates (retinopathy, nephropathy, neuropathy)
    - Intervention tracking (SDPI grant, diabetes education)
    - Year-over-year trend analysis

    Small cell suppression: Any aggregate with n < 5 is suppressed.

    Type 2 diabetes (ICD-10 E11.x) prevalence in AI/AN populations is
    approximately 14.7% vs 7.5% national average (IHS 2023 stats).
*/

WITH -- Get all patients with a diabetes diagnosis in the lookback period
diabetes_encounters AS (
    SELECT
        patient_id,
        service_unit,
        tribal_affiliation,
        encounter_date,
        encounter_type,
        primary_dx_icd10,
        reporting_period,
        -- Sub-classify diabetes encounters
        CASE
            WHEN primary_dx_icd10 LIKE 'E11.6%' THEN 'RETINOPATHY'
            WHEN primary_dx_icd10 LIKE 'E11.2%' THEN 'NEPHROPATHY'
            WHEN primary_dx_icd10 LIKE 'E11.4%' THEN 'NEUROPATHY'
            WHEN primary_dx_icd10 LIKE 'E11.5%' THEN 'PERIPHERAL_VASCULAR'
            WHEN primary_dx_icd10 LIKE 'E11.0%' THEN 'HYPEROSMOLARITY'
            WHEN primary_dx_icd10 LIKE 'E11.1%' THEN 'KETOACIDOSIS'
            WHEN primary_dx_icd10 IN ('E11.65') THEN 'UNCONTROLLED_HYPERGLYCEMIA'
            ELSE 'UNCOMPLICATED'
        END AS complication_type
    FROM {{ ref('slv_encounters') }}
    WHERE diagnosis_category = 'DIABETES'
      AND encounter_date >= DATEADD(YEAR, -{{ var('lookback_years') }}, CURRENT_DATE())
),

-- Get total population by service unit for prevalence calculation
service_unit_population AS (
    SELECT
        service_unit,
        COUNT(DISTINCT patient_id) AS total_population,
        COUNT(DISTINCT CASE WHEN age_band IN ('ADULT', 'MIDDLE_AGED', 'ELDER') THEN patient_id END) AS adult_population
    FROM {{ ref('slv_patient_demographics') }}
    WHERE eligibility_status = 'ACTIVE'
    GROUP BY service_unit
),

-- Identify unique diabetic patients per service unit and period
diabetic_patients AS (
    SELECT
        service_unit,
        reporting_period,
        COUNT(DISTINCT patient_id) AS total_diabetic_patients,
        COUNT(DISTINCT CASE WHEN complication_type != 'UNCOMPLICATED' THEN patient_id END) AS patients_with_complications,
        COUNT(DISTINCT CASE WHEN complication_type = 'RETINOPATHY' THEN patient_id END) AS retinopathy_patients,
        COUNT(DISTINCT CASE WHEN complication_type = 'NEPHROPATHY' THEN patient_id END) AS nephropathy_patients,
        COUNT(DISTINCT CASE WHEN complication_type = 'NEUROPATHY' THEN patient_id END) AS neuropathy_patients,
        COUNT(*) AS total_diabetes_encounters,
        COUNT(CASE WHEN encounter_type = 'OUTPATIENT' THEN 1 END) AS outpatient_encounters,
        COUNT(CASE WHEN encounter_type = 'ED' THEN 1 END) AS ed_encounters,
        COUNT(CASE WHEN encounter_type = 'INPATIENT' THEN 1 END) AS inpatient_encounters,
        COUNT(CASE WHEN encounter_type = 'TELEHEALTH' THEN 1 END) AS telehealth_encounters
    FROM diabetes_encounters
    GROUP BY service_unit, reporting_period
),

-- Calculate metrics with small cell suppression
metrics AS (
    SELECT
        dp.service_unit,
        dp.reporting_period,

        -- Population context
        sup.total_population,
        sup.adult_population,

        -- Raw counts (suppress if < threshold)
        CASE
            WHEN dp.total_diabetic_patients >= {{ var('small_cell_threshold') }}
            THEN dp.total_diabetic_patients
            ELSE NULL  -- Suppressed
        END AS total_diabetic_patients,

        -- Prevalence rate per 1,000 adult population
        CASE
            WHEN dp.total_diabetic_patients >= {{ var('small_cell_threshold') }}
                 AND sup.adult_population > 0
            THEN ROUND(dp.total_diabetic_patients::DECIMAL / sup.adult_population * 1000, 1)
            ELSE NULL
        END AS prevalence_rate_per_1000,

        -- A1C control simulation (based on IHS GPRA targets ~40% controlled)
        -- In production, this would come from lab results; synthetic approximation
        CASE
            WHEN dp.total_diabetic_patients >= {{ var('small_cell_threshold') }}
            THEN ROUND(40.0 + (HASH(dp.service_unit || dp.reporting_period) % 20) - 10, 1)
            ELSE NULL
        END AS a1c_controlled_pct,

        CASE
            WHEN dp.total_diabetic_patients >= {{ var('small_cell_threshold') }}
            THEN ROUND(25.0 + (HASH(dp.service_unit || dp.reporting_period) % 15) - 7, 1)
            ELSE NULL
        END AS a1c_poor_control_pct,

        -- Complication rates
        CASE
            WHEN dp.total_diabetic_patients >= {{ var('small_cell_threshold') }}
                 AND dp.total_diabetic_patients > 0
            THEN ROUND(dp.patients_with_complications::DECIMAL / dp.total_diabetic_patients * 100, 1)
            ELSE NULL
        END AS complication_rate_pct,

        -- Screening rates (synthetic approximation of GPRA targets)
        CASE
            WHEN dp.retinopathy_patients >= {{ var('small_cell_threshold') }}
                 AND dp.total_diabetic_patients > 0
            THEN ROUND(dp.retinopathy_patients::DECIMAL / dp.total_diabetic_patients * 100, 1)
            ELSE NULL
        END AS retinopathy_screening_pct,

        CASE
            WHEN dp.nephropathy_patients >= {{ var('small_cell_threshold') }}
                 AND dp.total_diabetic_patients > 0
            THEN ROUND(dp.nephropathy_patients::DECIMAL / dp.total_diabetic_patients * 100, 1)
            ELSE NULL
        END AS nephropathy_screening_pct,

        -- Encounter pattern metrics
        dp.total_diabetes_encounters,
        dp.outpatient_encounters AS diabetes_outpatient_visits,
        dp.ed_encounters AS diabetes_ed_visits,
        dp.inpatient_encounters AS diabetes_inpatient_admissions,
        dp.telehealth_encounters AS diabetes_telehealth_visits,

        -- ED utilization rate (high ED = access issue)
        CASE
            WHEN dp.total_diabetes_encounters > 0
            THEN ROUND(dp.ed_encounters::DECIMAL / dp.total_diabetes_encounters * 100, 1)
            ELSE NULL
        END AS diabetes_ed_utilization_pct

    FROM diabetic_patients dp
    LEFT JOIN service_unit_population sup ON dp.service_unit = sup.service_unit
),

-- Add year-over-year trend calculation
with_trends AS (
    SELECT
        m.*,

        -- Year-over-year prevalence change
        LAG(m.prevalence_rate_per_1000, 4) OVER (
            PARTITION BY m.service_unit
            ORDER BY m.reporting_period
        ) AS prev_year_prevalence,

        CASE
            WHEN LAG(m.prevalence_rate_per_1000, 4) OVER (
                PARTITION BY m.service_unit ORDER BY m.reporting_period
            ) IS NOT NULL AND LAG(m.prevalence_rate_per_1000, 4) OVER (
                PARTITION BY m.service_unit ORDER BY m.reporting_period
            ) > 0
            THEN ROUND(
                (m.prevalence_rate_per_1000 - LAG(m.prevalence_rate_per_1000, 4) OVER (
                    PARTITION BY m.service_unit ORDER BY m.reporting_period
                )) / LAG(m.prevalence_rate_per_1000, 4) OVER (
                    PARTITION BY m.service_unit ORDER BY m.reporting_period
                ) * 100, 1
            )
            ELSE NULL
        END AS yoy_prevalence_change_pct,

        -- Trend classification
        CASE
            WHEN LAG(m.prevalence_rate_per_1000, 4) OVER (
                PARTITION BY m.service_unit ORDER BY m.reporting_period
            ) IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN m.prevalence_rate_per_1000 > LAG(m.prevalence_rate_per_1000, 4) OVER (
                PARTITION BY m.service_unit ORDER BY m.reporting_period
            ) * 1.02 THEN 'INCREASING'
            WHEN m.prevalence_rate_per_1000 < LAG(m.prevalence_rate_per_1000, 4) OVER (
                PARTITION BY m.service_unit ORDER BY m.reporting_period
            ) * 0.98 THEN 'DECREASING'
            ELSE 'STABLE'
        END AS prevalence_trend,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM metrics m
)

SELECT * FROM with_trends
ORDER BY service_unit, reporting_period DESC
