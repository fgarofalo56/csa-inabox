-- materialized='table': Full rebuild required — trend analysis requires
-- historical comparisons making incremental unreliable.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'doj', 'trends', 'analysis']
  )
}}

/*
  Gold: Antitrust enforcement trends analysis.

  Provides year-over-year trends in case filings, enforcement actions,
  penalties, and outcomes for executive dashboards and policy analysis.
*/

WITH case_metrics_by_year AS (
    SELECT
        fiscal_year,
        COUNT(*) AS total_cases,
        COUNT(CASE WHEN case_type = 'CRIMINAL' THEN 1 END) AS criminal_cases,
        COUNT(CASE WHEN case_type = 'CIVIL' THEN 1 END) AS civil_cases,
        COUNT(CASE WHEN status IN ('CONVICTED', 'SETTLED') THEN 1 END) AS successful_cases,
        COUNT(CASE WHEN status = 'DISMISSED' THEN 1 END) AS dismissed_cases,
        COUNT(CASE WHEN status = 'OPEN' THEN 1 END) AS open_cases,
        AVG(days_to_resolution) AS avg_days_to_resolution
    FROM {{ ref('fact_enforcement_actions') }}
    WHERE filing_date IS NOT NULL
    GROUP BY fiscal_year
),

penalty_metrics_by_year AS (
    SELECT
        fiscal_year,
        SUM(total_criminal_fines) AS total_criminal_fines,
        SUM(total_jail_days) AS total_jail_days,
        SUM(total_restitution) AS total_restitution,
        AVG(CASE WHEN total_criminal_fines > 0 THEN total_criminal_fines END) AS avg_criminal_fine,
        COUNT(CASE WHEN is_significant_fine = TRUE THEN 1 END) AS significant_fine_cases,
        SUM(criminal_defendants) AS total_criminal_defendants
    FROM {{ ref('fact_enforcement_actions') }}
    WHERE filing_date IS NOT NULL
    GROUP BY fiscal_year
),

industry_diversity_by_year AS (
    SELECT
        fiscal_year,
        COUNT(DISTINCT industry_code) AS industries_prosecuted,
        COUNT(CASE WHEN is_highly_regulated = TRUE THEN 1 END) AS regulated_industry_cases
    FROM {{ ref('fact_enforcement_actions') }}
    WHERE filing_date IS NOT NULL
    GROUP BY fiscal_year
),

violation_trends_by_year AS (
    SELECT
        fiscal_year,
        COUNT(CASE WHEN enforcement_priority = 'HIGH' THEN 1 END) AS high_priority_violations,
        COUNT(CASE WHEN statutory_basis LIKE '%Section 1%' THEN 1 END) AS section1_cases,
        COUNT(CASE WHEN statutory_basis LIKE '%Section 2%' THEN 1 END) AS section2_cases,
        COUNT(CASE WHEN statutory_basis LIKE '%Section 7%' THEN 1 END) AS merger_cases
    FROM {{ ref('fact_enforcement_actions') }}
    WHERE filing_date IS NOT NULL
    GROUP BY fiscal_year
),

combined_metrics AS (
    SELECT
        c.fiscal_year,
        c.total_cases,
        c.criminal_cases,
        c.civil_cases,
        c.successful_cases,
        c.dismissed_cases,
        c.open_cases,
        c.avg_days_to_resolution,

        p.total_criminal_fines,
        p.total_jail_days,
        p.total_restitution,
        p.avg_criminal_fine,
        p.significant_fine_cases,
        p.total_criminal_defendants,

        i.industries_prosecuted,
        i.regulated_industry_cases,

        v.high_priority_violations,
        v.section1_cases,
        v.section2_cases,
        v.merger_cases,

        -- Success rates
        CASE WHEN c.total_cases > 0
            THEN ROUND((c.successful_cases * 100.0) / c.total_cases, 2)
            ELSE 0
        END AS success_rate_pct,

        -- Criminal vs civil mix
        CASE WHEN c.total_cases > 0
            THEN ROUND((c.criminal_cases * 100.0) / c.total_cases, 2)
            ELSE 0
        END AS criminal_case_pct

    FROM case_metrics_by_year c
    LEFT JOIN penalty_metrics_by_year p ON c.fiscal_year = p.fiscal_year
    LEFT JOIN industry_diversity_by_year i ON c.fiscal_year = i.fiscal_year
    LEFT JOIN violation_trends_by_year v ON c.fiscal_year = v.fiscal_year
),

trends_with_yoy_change AS (
    SELECT
        *,
        -- Year-over-year changes
        LAG(total_cases, 1) OVER (ORDER BY fiscal_year) AS prev_year_cases,
        LAG(total_criminal_fines, 1) OVER (ORDER BY fiscal_year) AS prev_year_fines,
        LAG(success_rate_pct, 1) OVER (ORDER BY fiscal_year) AS prev_year_success_rate,

        CASE
            WHEN LAG(total_cases, 1) OVER (ORDER BY fiscal_year) > 0
            THEN ROUND(((total_cases - LAG(total_cases, 1) OVER (ORDER BY fiscal_year)) * 100.0)
                      / LAG(total_cases, 1) OVER (ORDER BY fiscal_year), 2)
            ELSE NULL
        END AS cases_yoy_change_pct,

        CASE
            WHEN LAG(total_criminal_fines, 1) OVER (ORDER BY fiscal_year) > 0
            THEN ROUND(((total_criminal_fines - LAG(total_criminal_fines, 1) OVER (ORDER BY fiscal_year)) * 100.0)
                      / LAG(total_criminal_fines, 1) OVER (ORDER BY fiscal_year), 2)
            ELSE NULL
        END AS fines_yoy_change_pct,

        now() AS _dbt_refreshed_at

    FROM combined_metrics
)

SELECT * FROM trends_with_yoy_change
ORDER BY fiscal_year