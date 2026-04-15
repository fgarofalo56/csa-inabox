{{ config(
    materialized='table',
    tags=['gold', 'snap_trends', 'social_programs', 'analytics']
) }}

WITH base_enrollment AS (
    SELECT
        state_code,
        state_name,
        county_fips,
        county_name,
        fiscal_year,
        month_number,
        enrollment_date,
        program,
        persons,
        households,
        benefits_dollars,
        benefits_per_person,
        benefits_per_household,
        persons_per_household,
        persons_3mo_avg,
        benefits_dollars_3mo_avg,
        persons_yoy_pct_change,
        benefits_yoy_pct_change
    FROM {{ ref('slv_snap_enrollment') }}
    WHERE program = 'SNAP'
      AND enrollment_date >= DATE_SUB(CURRENT_DATE(), 365 * 5)  -- Last 5 years
),

-- Monthly state-level aggregations
monthly_state_trends AS (
    SELECT
        state_code,
        state_name,
        fiscal_year,
        month_number,
        enrollment_date,

        -- Aggregated enrollment metrics
        SUM(persons) as total_persons,
        SUM(households) as total_households,
        SUM(benefits_dollars) as total_benefits_dollars,

        -- Calculated averages
        CASE
            WHEN SUM(persons) > 0
            THEN ROUND(SUM(benefits_dollars) / SUM(persons), 2)
            ELSE 0
        END as avg_benefits_per_person,

        CASE
            WHEN SUM(households) > 0
            THEN ROUND(SUM(benefits_dollars) / SUM(households), 2)
            ELSE 0
        END as avg_benefits_per_household,

        CASE
            WHEN SUM(households) > 0
            THEN ROUND(SUM(persons)::DECIMAL / SUM(households)::DECIMAL, 2)
            ELSE 0
        END as avg_persons_per_household,

        -- Count participating counties
        COUNT(DISTINCT county_fips) as counties_participating

    FROM base_enrollment
    WHERE county_fips IS NOT NULL  -- Exclude state-level records to avoid double counting
    GROUP BY state_code, state_name, fiscal_year, month_number, enrollment_date
),

-- Calculate trends and changes
trend_calculations AS (
    SELECT
        *,

        -- Year-over-year changes
        LAG(total_persons, 12) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
        ) as total_persons_prev_year,

        LAG(total_households, 12) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
        ) as total_households_prev_year,

        LAG(total_benefits_dollars, 12) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
        ) as total_benefits_prev_year,

        -- 3-month moving averages
        AVG(total_persons) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) as persons_3mo_avg,

        AVG(total_benefits_dollars) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) as benefits_3mo_avg,

        -- 12-month rolling averages
        AVG(total_persons) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) as persons_12mo_avg,

        -- Seasonal adjustment (compare to same month last year)
        LAG(total_persons, 12) OVER (
            PARTITION BY state_code, month_number
            ORDER BY enrollment_date
        ) as total_persons_same_month_prev_year

    FROM monthly_state_trends
),

-- Calculate percentage changes and growth rates
growth_analysis AS (
    SELECT
        *,

        -- Year-over-year percentage changes
        CASE
            WHEN total_persons_prev_year > 0
            THEN ROUND((total_persons - total_persons_prev_year)::DECIMAL / total_persons_prev_year::DECIMAL * 100, 2)
            ELSE NULL
        END as persons_yoy_pct_change,

        CASE
            WHEN total_households_prev_year > 0
            THEN ROUND((total_households - total_households_prev_year)::DECIMAL / total_households_prev_year::DECIMAL * 100, 2)
            ELSE NULL
        END as households_yoy_pct_change,

        CASE
            WHEN total_benefits_prev_year > 0
            THEN ROUND((total_benefits_dollars - total_benefits_prev_year) / total_benefits_prev_year * 100, 2)
            ELSE NULL
        END as benefits_yoy_pct_change,

        -- Seasonal growth (vs same month last year)
        CASE
            WHEN total_persons_same_month_prev_year > 0
            THEN ROUND((total_persons - total_persons_same_month_prev_year)::DECIMAL / total_persons_same_month_prev_year::DECIMAL * 100, 2)
            ELSE NULL
        END as persons_seasonal_pct_change,

        -- Trend classification
        CASE
            WHEN total_persons_prev_year IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN persons_yoy_pct_change > 5 THEN 'INCREASING'
            WHEN persons_yoy_pct_change < -5 THEN 'DECREASING'
            ELSE 'STABLE'
        END as enrollment_trend

    FROM trend_calculations
),

-- Economic correlation indicators (placeholder for future enhancement)
economic_indicators AS (
    SELECT
        *,

        -- Calculate volatility
        STDDEV(persons_yoy_pct_change) OVER (
            PARTITION BY state_code
            ORDER BY enrollment_date
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) as enrollment_volatility,

        -- Economic correlation placeholders
        NULL as unemployment_rate,
        NULL as median_income,
        NULL as poverty_rate,
        NULL as economic_correlation_score,

        -- Program effectiveness metrics
        CASE
            WHEN counties_participating > 0 AND total_persons > 0
            THEN ROUND(total_persons::DECIMAL / counties_participating::DECIMAL, 0)
            ELSE 0
        END as avg_persons_per_county

    FROM growth_analysis
),

-- Create latest snapshot for dashboard
latest_snapshot AS (
    SELECT
        state_code,
        state_name,
        MAX(enrollment_date) as latest_enrollment_date,
        MAX(fiscal_year) as latest_fiscal_year

    FROM economic_indicators
    GROUP BY state_code, state_name
),

-- Final summary with all metrics
final_summary AS (
    SELECT
        ei.state_code,
        ei.state_name,
        ei.fiscal_year,
        ei.month_number,
        ei.enrollment_date,

        -- Current enrollment
        ei.total_persons as current_enrollment,
        ei.total_households as current_households,
        ei.total_benefits_dollars as current_benefits_dollars,

        -- Per-capita metrics
        ei.avg_benefits_per_person,
        ei.avg_benefits_per_household,
        ei.avg_persons_per_household,

        -- Trend indicators
        ei.persons_yoy_pct_change as enrollment_change_1yr,
        ei.benefits_yoy_pct_change as benefits_change_1yr,
        ei.persons_seasonal_pct_change as seasonal_change,
        ei.enrollment_trend,

        -- Smoothed metrics
        ROUND(ei.persons_3mo_avg, 0) as enrollment_3mo_avg,
        ROUND(ei.persons_12mo_avg, 0) as enrollment_12mo_avg,
        ROUND(ei.benefits_3mo_avg, 0) as benefits_3mo_avg,

        -- Geographic coverage
        ei.counties_participating,
        ei.avg_persons_per_county,

        -- Economic context (placeholders)
        ei.unemployment_rate,
        ei.median_income,
        ei.poverty_rate,
        ei.economic_correlation_score,

        -- Quality indicators
        ROUND(ei.enrollment_volatility, 2) as enrollment_volatility,

        CASE
            WHEN ei.total_persons > 0
                 AND ei.persons_yoy_pct_change IS NOT NULL
                 AND ei.enrollment_date >= DATE_SUB(CURRENT_DATE(), 90)
            THEN TRUE
            ELSE FALSE
        END as is_current_data,

        -- Flag for latest data point
        CASE
            WHEN ei.enrollment_date = ls.latest_enrollment_date
            THEN TRUE
            ELSE FALSE
        END as is_latest_month,

        -- Metadata
        CURRENT_DATE() as report_date,
        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM economic_indicators ei
    LEFT JOIN latest_snapshot ls
        ON ei.state_code = ls.state_code
)

SELECT * FROM final_summary
ORDER BY state_code, enrollment_date DESC