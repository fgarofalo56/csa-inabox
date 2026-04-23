-- materialized='table': Full rebuild required for comprehensive penalty
-- analysis with complex cross-year calculations and industry comparisons.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'doj', 'penalty', 'analysis']
  )
}}

/*
  Gold: Penalty analysis by violation type, industry, and time period.

  Provides comprehensive analysis of criminal fines, jail sentences, and
  restitution amounts to inform enforcement policy and deterrence effectiveness.
*/

WITH enforcement_base AS (
    SELECT
        fiscal_year,
        industry_code,
        violation_type,
        statutory_basis,
        enforcement_priority,
        defendant_type,
        total_criminal_fines,
        total_jail_days,
        total_restitution,
        criminal_defendants,
        is_significant_fine,
        enforcement_outcome_type
    FROM {{ ref('fact_enforcement_actions') }}
    WHERE total_criminal_fines > 0 OR total_jail_days > 0 OR total_restitution > 0
),

penalty_by_violation_type AS (
    SELECT
        violation_type,
        statutory_basis,
        enforcement_priority,
        COUNT(*) AS cases_with_penalties,
        SUM(total_criminal_fines) AS total_fines,
        AVG(total_criminal_fines) AS avg_fine_per_case,
        SUM(total_jail_days) AS total_jail_days,
        AVG(total_jail_days) AS avg_jail_days_per_case,
        SUM(total_restitution) AS total_restitution,
        AVG(total_restitution) AS avg_restitution_per_case,
        SUM(criminal_defendants) AS total_defendants,
        COUNT(CASE WHEN is_significant_fine = TRUE THEN 1 END) AS significant_fine_cases,
        MAX(total_criminal_fines) AS max_fine,
        MIN(total_criminal_fines) AS min_fine
    FROM enforcement_base
    GROUP BY violation_type, statutory_basis, enforcement_priority
),

penalty_by_industry AS (
    SELECT
        industry_code,
        COUNT(*) AS cases_with_penalties,
        SUM(total_criminal_fines) AS total_fines_by_industry,
        AVG(total_criminal_fines) AS avg_fine_per_industry_case,
        SUM(total_jail_days) AS total_jail_days_by_industry,
        AVG(total_jail_days) AS avg_jail_days_per_industry_case,
        SUM(criminal_defendants) AS total_defendants_by_industry,
        COUNT(CASE WHEN defendant_type = 'CORPORATION' THEN 1 END) AS corporate_cases,
        COUNT(CASE WHEN defendant_type = 'INDIVIDUAL' THEN 1 END) AS individual_cases
    FROM enforcement_base
    GROUP BY industry_code
),

penalty_by_year AS (
    SELECT
        fiscal_year,
        COUNT(*) AS cases_with_penalties,
        SUM(total_criminal_fines) AS annual_total_fines,
        AVG(total_criminal_fines) AS avg_fine_per_year,
        SUM(total_jail_days) AS annual_total_jail_days,
        AVG(total_jail_days) AS avg_jail_days_per_year,
        SUM(total_restitution) AS annual_total_restitution,
        COUNT(CASE WHEN is_significant_fine = TRUE THEN 1 END) AS significant_fine_cases_per_year,
        -- Percentiles for fine distribution
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_criminal_fines) AS median_fine,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY total_criminal_fines) AS p75_fine,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY total_criminal_fines) AS p90_fine
    FROM enforcement_base
    WHERE total_criminal_fines > 0
    GROUP BY fiscal_year
),

defendant_type_analysis AS (
    SELECT
        defendant_type,
        COUNT(*) AS cases_by_defendant_type,
        SUM(total_criminal_fines) AS total_fines_by_defendant_type,
        AVG(total_criminal_fines) AS avg_fine_by_defendant_type,
        SUM(total_jail_days) AS total_jail_days_by_defendant_type,
        AVG(total_jail_days) AS avg_jail_days_by_defendant_type,
        -- Corporate-specific metrics
        CASE WHEN defendant_type = 'CORPORATION'
            THEN AVG(total_criminal_fines / NULLIF(criminal_defendants, 0))
            ELSE NULL
        END AS avg_fine_per_corporate_defendant
    FROM enforcement_base
    GROUP BY defendant_type
),

penalty_trends AS (
    SELECT
        fiscal_year,
        annual_total_fines,
        avg_fine_per_year,
        LAG(annual_total_fines, 1) OVER (ORDER BY fiscal_year) AS prev_year_total_fines,
        LAG(avg_fine_per_year, 1) OVER (ORDER BY fiscal_year) AS prev_year_avg_fine,

        -- Year-over-year growth rates
        CASE
            WHEN LAG(annual_total_fines, 1) OVER (ORDER BY fiscal_year) > 0
            THEN ROUND(((annual_total_fines - LAG(annual_total_fines, 1) OVER (ORDER BY fiscal_year)) * 100.0)
                      / LAG(annual_total_fines, 1) OVER (ORDER BY fiscal_year), 2)
            ELSE NULL
        END AS total_fines_yoy_change_pct,

        CASE
            WHEN LAG(avg_fine_per_year, 1) OVER (ORDER BY fiscal_year) > 0
            THEN ROUND(((avg_fine_per_year - LAG(avg_fine_per_year, 1) OVER (ORDER BY fiscal_year)) * 100.0)
                      / LAG(avg_fine_per_year, 1) OVER (ORDER BY fiscal_year), 2)
            ELSE NULL
        END AS avg_fine_yoy_change_pct
    FROM penalty_by_year
),

-- Create a summary table that combines key metrics
final_analysis AS (
    SELECT
        'VIOLATION_TYPE' AS analysis_type,
        violation_type AS category,
        NULL AS industry_code,
        NULL AS defendant_type,
        NULL AS fiscal_year,
        cases_with_penalties,
        total_fines AS penalty_amount,
        avg_fine_per_case AS avg_penalty_per_case,
        total_jail_days,
        avg_jail_days_per_case,
        total_defendants,
        statutory_basis AS additional_info,
        enforcement_priority AS priority_level,
        significant_fine_cases
    FROM penalty_by_violation_type

    UNION ALL

    SELECT
        'INDUSTRY' AS analysis_type,
        industry_code AS category,
        industry_code,
        NULL AS defendant_type,
        NULL AS fiscal_year,
        cases_with_penalties,
        total_fines_by_industry AS penalty_amount,
        avg_fine_per_industry_case AS avg_penalty_per_case,
        total_jail_days_by_industry AS total_jail_days,
        avg_jail_days_per_industry_case AS avg_jail_days_per_case,
        total_defendants_by_industry AS total_defendants,
        CONCAT('Corporate: ', corporate_cases, ', Individual: ', individual_cases) AS additional_info,
        NULL AS priority_level,
        NULL AS significant_fine_cases
    FROM penalty_by_industry

    UNION ALL

    SELECT
        'DEFENDANT_TYPE' AS analysis_type,
        defendant_type AS category,
        NULL AS industry_code,
        defendant_type,
        NULL AS fiscal_year,
        cases_by_defendant_type AS cases_with_penalties,
        total_fines_by_defendant_type AS penalty_amount,
        avg_fine_by_defendant_type AS avg_penalty_per_case,
        total_jail_days_by_defendant_type AS total_jail_days,
        avg_jail_days_by_defendant_type AS avg_jail_days_per_case,
        NULL AS total_defendants,
        CASE
            WHEN defendant_type = 'CORPORATION' AND avg_fine_per_corporate_defendant IS NOT NULL
            THEN CONCAT('Avg per corp defendant: $', ROUND(avg_fine_per_corporate_defendant, 0))
            ELSE 'Individual penalties'
        END AS additional_info,
        NULL AS priority_level,
        NULL AS significant_fine_cases
    FROM defendant_type_analysis
)

SELECT
    *,
    now() AS _dbt_refreshed_at
FROM final_analysis
ORDER BY
    analysis_type,
    CASE WHEN penalty_amount IS NOT NULL THEN penalty_amount ELSE 0 END DESC