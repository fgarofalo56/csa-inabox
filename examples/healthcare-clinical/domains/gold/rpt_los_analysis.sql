-- ==========================================================================
-- Gold Report: Length-of-Stay Analysis
-- Analyzes length-of-stay distributions by DRG, facility, and time period.
-- Compares actual vs. expected LOS to identify variation drivers.
-- All data is synthetic — no real PHI.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH encounters AS (
    SELECT * FROM {{ ref('fct_encounters') }}
    WHERE encounter_type = 'Inpatient'
      AND length_of_stay_days IS NOT NULL
),

diagnoses AS (
    SELECT * FROM {{ ref('dim_diagnoses') }}
    WHERE is_primary_diagnosis = TRUE
),

-- Expected LOS benchmarks by DRG (representative values)
drg_benchmarks AS (
    SELECT '291' AS drg_code, 'Heart Failure'       AS drg_description, 4.5 AS expected_los_days UNION ALL
    SELECT '292',              'Heart Failure',                           3.8 UNION ALL
    SELECT '190',              'COPD',                                    3.7 UNION ALL
    SELECT '194',              'Pneumonia',                               4.2 UNION ALL
    SELECT '195',              'Pneumonia',                               3.1 UNION ALL
    SELECT '683',              'Kidney Disease',                          3.9 UNION ALL
    SELECT '470',              'Joint Replacement',                       2.5 UNION ALL
    SELECT '536',              'Hip Fracture',                            5.2 UNION ALL
    SELECT '065',              'Cerebral Infarction',                     3.6 UNION ALL
    SELECT '999',              'Other',                                   3.5
),

-- LOS by DRG and facility
los_by_drg_facility AS (
    SELECT
        e.drg_code,
        e.facility,
        DATE_FORMAT(e.discharge_date, 'yyyy-MM')    AS discharge_period,
        COUNT(DISTINCT e.encounter_id)              AS encounter_count,
        ROUND(AVG(e.length_of_stay_days), 1)        AS avg_los_days,
        ROUND(PERCENTILE_APPROX(e.length_of_stay_days, 0.5), 1)
                                                    AS median_los_days,
        MIN(e.length_of_stay_days)                  AS min_los_days,
        MAX(e.length_of_stay_days)                  AS max_los_days,
        ROUND(STDDEV(e.length_of_stay_days), 2)     AS stddev_los_days,

        -- Readmission correlation
        ROUND(
            SUM(CASE WHEN e.is_30day_readmission THEN 1 ELSE 0 END) * 100.0 /
            NULLIF(COUNT(DISTINCT e.encounter_id), 0),
            2
        )                                           AS readmission_rate_pct,

        -- Payer mix
        COUNT(DISTINCT e.payer)                     AS payer_count

    FROM encounters e
    GROUP BY e.drg_code, e.facility, DATE_FORMAT(e.discharge_date, 'yyyy-MM')
),

-- Join with benchmarks and primary diagnosis context
final AS (
    SELECT
        ldf.drg_code,
        COALESCE(db.drg_description, d_agg.top_clinical_domain, 'Unknown')
                                                    AS drg_description,
        ldf.facility,
        ldf.discharge_period,
        ldf.encounter_count,
        ldf.avg_los_days,
        ldf.median_los_days,
        ldf.min_los_days,
        ldf.max_los_days,
        ldf.stddev_los_days,
        COALESCE(db.expected_los_days, 3.5)         AS expected_los_days,
        ROUND(ldf.avg_los_days - COALESCE(db.expected_los_days, 3.5), 1)
                                                    AS los_variance,
        CASE
            WHEN ldf.avg_los_days > COALESCE(db.expected_los_days, 3.5) * 1.2
                THEN 'Above Expected'
            WHEN ldf.avg_los_days < COALESCE(db.expected_los_days, 3.5) * 0.8
                THEN 'Below Expected'
            ELSE 'Within Expected'
        END                                         AS los_status,
        ldf.readmission_rate_pct,
        ldf.payer_count,
        CURRENT_TIMESTAMP()                         AS calculated_at

    FROM los_by_drg_facility ldf
    LEFT JOIN drg_benchmarks db
        ON ldf.drg_code = db.drg_code
    LEFT JOIN (
        -- Get the most common clinical domain per DRG for labeling
        SELECT
            e2.drg_code,
            FIRST_VALUE(d2.clinical_domain) OVER (
                PARTITION BY e2.drg_code
                ORDER BY COUNT(*) DESC
            )                                       AS top_clinical_domain
        FROM {{ ref('fct_encounters') }} e2
        INNER JOIN {{ ref('dim_diagnoses') }} d2
            ON e2.encounter_id = d2.encounter_id AND d2.is_primary_diagnosis = TRUE
        GROUP BY e2.drg_code, d2.clinical_domain
    ) d_agg
        ON ldf.drg_code = d_agg.drg_code
)

SELECT * FROM final
