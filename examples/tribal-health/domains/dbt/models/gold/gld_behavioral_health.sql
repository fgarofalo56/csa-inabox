{{ config(
    materialized='table',
    tags=['gold', 'behavioral_health', 'hipaa', 'analytics', '42cfr_part2']
) }}

/*
    Gold Layer — Behavioral Health Dashboard

    Aggregates behavioral health encounters to produce service utilization
    metrics, provider-to-population ratios, waitlist analysis, and
    crisis intervention tracking.

    CRITICAL: Substance use disorder data is 42 CFR Part 2 protected.
    This model includes SUD data only in aggregate form with small cell
    suppression. Individual-level SUD data requires separate consent.

    Behavioral health encompasses:
    - Substance Use Disorders (SUD): ICD-10 F10-F19
    - Mental Health: ICD-10 F20-F48 (schizophrenia, mood, anxiety, etc.)
    - Crisis services: ED encounters for behavioral health

    Small cell suppression: Any aggregate with n < 5 is suppressed.
*/

WITH -- All behavioral health encounters in the lookback period
bh_encounters AS (
    SELECT
        patient_id,
        service_unit,
        tribal_affiliation,
        encounter_date,
        encounter_type,
        primary_dx_icd10,
        reporting_period,
        diagnosis_category,
        is_sud_protected,
        is_behavioral_health,
        provider_type,
        estimated_cost,
        -- Sub-classify behavioral health encounters
        CASE
            WHEN LEFT(primary_dx_icd10, 3) = 'F10' THEN 'ALCOHOL_USE'
            WHEN LEFT(primary_dx_icd10, 3) IN ('F11', 'F12', 'F13', 'F14',
                                                  'F15', 'F16', 'F18', 'F19') THEN 'DRUG_USE'
            WHEN LEFT(primary_dx_icd10, 3) = 'F17' THEN 'TOBACCO_USE'
            WHEN LEFT(primary_dx_icd10, 3) IN ('F32', 'F33') THEN 'DEPRESSION'
            WHEN LEFT(primary_dx_icd10, 3) IN ('F40', 'F41') THEN 'ANXIETY'
            WHEN LEFT(primary_dx_icd10, 3) IN ('F43') THEN 'PTSD_STRESS'
            WHEN LEFT(primary_dx_icd10, 3) IN ('F30', 'F31') THEN 'BIPOLAR'
            WHEN LEFT(primary_dx_icd10, 3) IN ('F20', 'F21', 'F25') THEN 'PSYCHOTIC'
            ELSE 'OTHER_BH'
        END AS bh_subcategory
    FROM {{ ref('slv_encounters') }}
    WHERE is_behavioral_health = TRUE
      AND encounter_date >= DATEADD(YEAR, -{{ var('lookback_years') }}, CURRENT_DATE())
),

-- Population denominators by service unit
service_unit_population AS (
    SELECT
        service_unit,
        COUNT(DISTINCT patient_id) AS total_population
    FROM {{ ref('slv_patient_demographics') }}
    WHERE eligibility_status = 'ACTIVE'
    GROUP BY service_unit
),

-- Provider counts from facility data
facility_providers AS (
    SELECT
        service_unit,
        SUM(CASE WHEN has_behavioral_health THEN provider_count ELSE 0 END) AS bh_provider_count
    FROM {{ ref('slv_facilities') }}
    GROUP BY service_unit
),

-- Aggregate by service unit and reporting period
bh_metrics AS (
    SELECT
        bhe.service_unit,
        bhe.reporting_period,

        -- Overall counts
        COUNT(*) AS total_bh_encounters,
        COUNT(DISTINCT bhe.patient_id) AS unique_bh_patients,

        -- SUD encounter counts (42 CFR Part 2 — aggregate only)
        COUNT(CASE WHEN bhe.is_sud_protected THEN 1 END) AS sud_encounters,
        COUNT(DISTINCT CASE WHEN bhe.is_sud_protected THEN bhe.patient_id END) AS sud_unique_patients,

        -- Mental health encounter counts
        COUNT(CASE WHEN NOT bhe.is_sud_protected THEN 1 END) AS mh_encounters,
        COUNT(DISTINCT CASE WHEN NOT bhe.is_sud_protected THEN bhe.patient_id END) AS mh_unique_patients,

        -- By subcategory
        COUNT(CASE WHEN bhe.bh_subcategory = 'ALCOHOL_USE' THEN 1 END) AS alcohol_encounters,
        COUNT(CASE WHEN bhe.bh_subcategory = 'DRUG_USE' THEN 1 END) AS drug_encounters,
        COUNT(CASE WHEN bhe.bh_subcategory = 'DEPRESSION' THEN 1 END) AS depression_encounters,
        COUNT(CASE WHEN bhe.bh_subcategory = 'ANXIETY' THEN 1 END) AS anxiety_encounters,
        COUNT(CASE WHEN bhe.bh_subcategory = 'PTSD_STRESS' THEN 1 END) AS ptsd_encounters,

        -- By encounter type
        COUNT(CASE WHEN bhe.encounter_type = 'ED' THEN 1 END) AS crisis_ed_encounters,
        COUNT(CASE WHEN bhe.encounter_type = 'INPATIENT' THEN 1 END) AS inpatient_bh_encounters,
        COUNT(CASE WHEN bhe.encounter_type = 'TELEHEALTH' THEN 1 END) AS telehealth_bh_encounters,
        COUNT(CASE WHEN bhe.encounter_type = 'OUTPATIENT' THEN 1 END) AS outpatient_bh_encounters,

        -- Cost
        SUM(bhe.estimated_cost) AS total_bh_cost

    FROM bh_encounters bhe
    GROUP BY bhe.service_unit, bhe.reporting_period
),

-- Combine with population and provider data
enriched AS (
    SELECT
        bm.service_unit,
        bm.reporting_period,

        -- Population context
        sup.total_population,

        -- Encounter counts with small cell suppression
        CASE WHEN bm.total_bh_encounters >= {{ var('small_cell_threshold') }} THEN bm.total_bh_encounters ELSE NULL END AS total_bh_encounters,
        CASE WHEN bm.unique_bh_patients >= {{ var('small_cell_threshold') }} THEN bm.unique_bh_patients ELSE NULL END AS unique_bh_patients,

        -- SUD metrics (42 CFR Part 2 — suppressed if < threshold)
        CASE WHEN bm.sud_encounters >= {{ var('small_cell_threshold') }} THEN bm.sud_encounters ELSE NULL END AS sud_encounters,
        CASE WHEN bm.sud_unique_patients >= {{ var('small_cell_threshold') }} THEN bm.sud_unique_patients ELSE NULL END AS sud_unique_patients,

        -- Rates per 1,000 population
        CASE
            WHEN bm.sud_encounters >= {{ var('small_cell_threshold') }} AND sup.total_population > 0
            THEN ROUND(bm.sud_encounters::DECIMAL / sup.total_population * 1000, 1)
            ELSE NULL
        END AS sud_encounter_rate_per_1000,

        CASE
            WHEN bm.mh_encounters >= {{ var('small_cell_threshold') }} AND sup.total_population > 0
            THEN ROUND(bm.mh_encounters::DECIMAL / sup.total_population * 1000, 1)
            ELSE NULL
        END AS mh_encounter_rate_per_1000,

        -- Provider ratio
        CASE
            WHEN fp.bh_provider_count IS NOT NULL AND sup.total_population > 0
            THEN ROUND(fp.bh_provider_count::DECIMAL / sup.total_population * 10000, 2)
            ELSE NULL
        END AS provider_ratio_per_10000,

        -- Waitlist estimate (synthetic — in production from scheduling system)
        -- Based on provider ratio: fewer providers = longer waits
        CASE
            WHEN fp.bh_provider_count IS NOT NULL AND sup.total_population > 0
            THEN ROUND(
                GREATEST(0,
                    30 - (fp.bh_provider_count::DECIMAL / sup.total_population * 10000 * 5)
                ) + (HASH(bm.service_unit || bm.reporting_period) % 10), 0
            )
            ELSE NULL
        END AS avg_waitlist_days,

        -- Crisis intervention count (ED encounters for BH)
        CASE WHEN bm.crisis_ed_encounters >= {{ var('small_cell_threshold') }} THEN bm.crisis_ed_encounters ELSE NULL END AS crisis_intervention_count,

        -- Telehealth utilization
        CASE
            WHEN bm.total_bh_encounters > 0
            THEN ROUND(bm.telehealth_bh_encounters::DECIMAL / bm.total_bh_encounters * 100, 1)
            ELSE 0.0
        END AS telehealth_utilization_pct,

        -- No-show rate estimate (synthetic)
        ROUND(15.0 + (HASH(bm.service_unit || bm.reporting_period) % 20), 1) AS no_show_rate_pct,

        -- Cost metrics
        ROUND(bm.total_bh_cost, 2) AS total_bh_cost,
        CASE
            WHEN bm.unique_bh_patients > 0
            THEN ROUND(bm.total_bh_cost / bm.unique_bh_patients, 2)
            ELSE NULL
        END AS cost_per_patient,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM bh_metrics bm
    LEFT JOIN service_unit_population sup ON bm.service_unit = sup.service_unit
    LEFT JOIN facility_providers fp ON bm.service_unit = fp.service_unit
)

SELECT * FROM enriched
ORDER BY service_unit, reporting_period DESC
