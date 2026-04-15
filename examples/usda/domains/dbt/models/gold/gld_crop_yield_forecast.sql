{{ config(
    materialized='table',
    tags=['gold', 'crop_yields', 'forecasting', 'analytics']
) }}

WITH base_yields AS (
    SELECT
        state_code,
        state_name,
        county_code,
        county_name,
        commodity,
        year,
        yield_per_acre,
        production_amount,
        planted_acres,
        harvested_acres,
        harvest_efficiency_pct
    FROM {{ ref('slv_crop_yields') }}
    WHERE yield_per_acre IS NOT NULL
      AND commodity IN {{ var('major_commodities') }}
),

-- Calculate historical trends and moving averages
trend_analysis AS (
    SELECT
        *,

        -- Moving averages
        AVG(yield_per_acre) OVER (
            PARTITION BY state_code, commodity
            ORDER BY year
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) as yield_3yr_avg,

        AVG(yield_per_acre) OVER (
            PARTITION BY state_code, commodity
            ORDER BY year
            ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
        ) as yield_5yr_avg,

        AVG(yield_per_acre) OVER (
            PARTITION BY state_code, commodity
            ORDER BY year
            ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
        ) as yield_10yr_avg,

        -- Year-over-year changes
        LAG(yield_per_acre, 1) OVER (
            PARTITION BY state_code, commodity
            ORDER BY year
        ) as yield_prev_year,

        -- Volatility measures (standard deviation)
        STDDEV(yield_per_acre) OVER (
            PARTITION BY state_code, commodity
            ORDER BY year
            ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
        ) as yield_5yr_stddev,

        -- Linear trend (slope) over last 5 years
        REGR_SLOPE(yield_per_acre, year) OVER (
            PARTITION BY state_code, commodity
            ORDER BY year
            ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
        ) as yield_5yr_trend_slope

    FROM base_yields
),

-- Calculate additional metrics
metrics_calculation AS (
    SELECT
        *,

        -- Percentage changes
        CASE
            WHEN yield_prev_year > 0
            THEN ROUND((yield_per_acre - yield_prev_year) / yield_prev_year * 100, 2)
            ELSE NULL
        END as yield_pct_change_1yr,

        -- Trend classification
        CASE
            WHEN yield_5yr_trend_slope > 0.5 THEN 'INCREASING'
            WHEN yield_5yr_trend_slope < -0.5 THEN 'DECREASING'
            ELSE 'STABLE'
        END as yield_trend_5yr,

        -- Volatility score (coefficient of variation)
        CASE
            WHEN yield_5yr_avg > 0 AND yield_5yr_stddev > 0
            THEN ROUND(yield_5yr_stddev / yield_5yr_avg * 100, 2)
            ELSE NULL
        END as yield_volatility_score,

        -- Performance vs state average
        AVG(yield_per_acre) OVER (
            PARTITION BY state_code, commodity, year
        ) as state_avg_yield_per_acre

    FROM trend_analysis
),

-- Simple forecasting using linear regression
forecasting AS (
    SELECT
        *,

        -- Next year forecast using trend
        CASE
            WHEN yield_5yr_trend_slope IS NOT NULL AND yield_3yr_avg > 0
            THEN ROUND(yield_3yr_avg + yield_5yr_trend_slope, 2)
            ELSE yield_3yr_avg
        END as yield_forecast_next_year,

        -- Confidence intervals based on historical volatility
        CASE
            WHEN yield_5yr_stddev IS NOT NULL AND yield_3yr_avg > 0
            THEN CONCAT(
                ROUND(yield_3yr_avg - (1.96 * yield_5yr_stddev), 1),
                ' - ',
                ROUND(yield_3yr_avg + (1.96 * yield_5yr_stddev), 1)
            )
            ELSE 'Insufficient data'
        END as yield_95pct_confidence_interval

    FROM metrics_calculation
),

-- Regional comparisons
regional_analysis AS (
    SELECT
        *,

        -- Rank within state for current year
        ROW_NUMBER() OVER (
            PARTITION BY state_code, commodity, year
            ORDER BY yield_per_acre DESC
        ) as county_yield_rank_in_state,

        -- Performance relative to state
        CASE
            WHEN state_avg_yield_per_acre > 0
            THEN ROUND((yield_per_acre / state_avg_yield_per_acre - 1) * 100, 2)
            ELSE NULL
        END as yield_vs_state_avg_pct

    FROM forecasting
),

-- Final aggregations and summary
final_summary AS (
    SELECT
        -- Identifiers
        state_code,
        state_name,
        county_code,
        county_name,
        commodity,
        year,

        -- Current metrics
        yield_per_acre,
        production_amount,
        planted_acres,
        harvested_acres,
        harvest_efficiency_pct,

        -- Historical trends
        ROUND(yield_3yr_avg, 2) as yield_3yr_avg,
        ROUND(yield_5yr_avg, 2) as yield_5yr_avg,
        ROUND(yield_10yr_avg, 2) as yield_10yr_avg,

        -- Changes and trends
        yield_pct_change_1yr,
        yield_trend_5yr,
        ROUND(yield_volatility_score, 2) as yield_volatility_score,

        -- Forecasting
        yield_forecast_next_year,
        yield_95pct_confidence_interval,
        'LINEAR_TREND' as forecast_method,

        -- Regional context
        county_yield_rank_in_state,
        yield_vs_state_avg_pct,
        ROUND(state_avg_yield_per_acre, 2) as state_avg_yield_per_acre,

        -- Economic indicators (placeholder for future enhancement)
        NULL as commodity_price_per_unit,
        NULL as economic_index,
        NULL as weather_impact_score,

        -- Quality indicators
        CASE
            WHEN yield_per_acre > 0
                 AND yield_3yr_avg IS NOT NULL
                 AND yield_forecast_next_year IS NOT NULL
            THEN TRUE
            ELSE FALSE
        END as is_forecast_reliable,

        -- Metadata
        CURRENT_DATE() as report_date,
        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM regional_analysis
    WHERE year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
)

SELECT * FROM final_summary
ORDER BY state_code, commodity, county_code, year DESC