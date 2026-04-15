{{ config(
    materialized='table',
    tags=['gold', 'severe_weather', 'risk_analytics']
) }}

{#
    Gold layer: Severe weather risk assessment by region and season.

    Combines cleaned storm event data to produce:
      - Storm frequency and probability by event type, season, and county
      - Impact scoring (damage, casualties, affected population)
      - Historical recurrence intervals for significant events
      - Warning effectiveness analysis (lead time vs. casualties)
      - Regional risk rankings and trend detection

    This model powers the Severe Weather Early Warning analytics and
    the Storm Warning System dashboard.
#}

WITH storm_base AS (
    SELECT
        *,
        -- Derive state-level FIPS for county lookup
        CONCAT(state_fips, county_zone_fips) AS county_fips
    FROM {{ ref('slv_storm_events') }}
    WHERE is_valid = TRUE
      AND event_year >= {{ var('analysis_start_year') }}
),

-- Annual event counts by type, state, and season
annual_event_stats AS (
    SELECT
        state,
        state_fips,
        event_type_std,
        event_season,
        event_year,

        -- Event counts
        COUNT(*) AS event_count,
        COUNT(CASE WHEN severity_category IN ('SEVERE', 'CATASTROPHIC') THEN 1 END) AS severe_event_count,

        -- Casualty totals
        SUM(total_injuries) AS total_injuries,
        SUM(total_deaths) AS total_deaths,
        SUM(total_casualties) AS total_casualties,

        -- Damage totals (CPI-adjusted)
        SUM(total_damage_adjusted_usd) AS total_damage_adjusted_usd,
        AVG(total_damage_adjusted_usd) AS avg_damage_per_event_usd,
        MAX(total_damage_adjusted_usd) AS max_single_event_damage_usd,

        -- Tornado-specific metrics
        MAX(tor_ef_rating) AS max_ef_rating,
        AVG(CASE WHEN tor_ef_rating IS NOT NULL THEN tor_ef_rating END) AS avg_ef_rating

    FROM storm_base
    GROUP BY state, state_fips, event_type_std, event_season, event_year
),

-- Calculate multi-year rolling statistics for risk scoring
rolling_stats AS (
    SELECT
        *,

        -- 5-year rolling average of event frequency
        AVG(event_count) OVER (
            PARTITION BY state, event_type_std, event_season
            ORDER BY event_year
            ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
        ) AS event_count_5yr_avg,

        -- 10-year rolling average
        AVG(event_count) OVER (
            PARTITION BY state, event_type_std, event_season
            ORDER BY event_year
            ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
        ) AS event_count_10yr_avg,

        -- Trend: is frequency increasing?
        REGR_SLOPE(event_count, event_year) OVER (
            PARTITION BY state, event_type_std, event_season
            ORDER BY event_year
            ROWS BETWEEN 9 PRECEDING AND CURRENT ROW
        ) AS frequency_trend_slope,

        -- 5-year rolling damage average
        AVG(total_damage_adjusted_usd) OVER (
            PARTITION BY state, event_type_std, event_season
            ORDER BY event_year
            ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
        ) AS damage_5yr_avg_usd,

        -- Total years of data for this combination
        COUNT(*) OVER (
            PARTITION BY state, event_type_std, event_season
            ORDER BY event_year
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS years_of_data

    FROM annual_event_stats
),

-- Compute probability and risk scores
risk_scoring AS (
    SELECT
        state,
        state_fips,
        event_type_std,
        event_season,
        event_year,

        -- Raw counts
        event_count,
        severe_event_count,
        total_injuries,
        total_deaths,
        total_casualties,
        total_damage_adjusted_usd,
        avg_damage_per_event_usd,
        max_single_event_damage_usd,

        -- Rolling averages
        ROUND(event_count_5yr_avg, 1) AS event_count_5yr_avg,
        ROUND(event_count_10yr_avg, 1) AS event_count_10yr_avg,
        ROUND(damage_5yr_avg_usd, 2) AS damage_5yr_avg_usd,

        -- Estimated annual probability (events per year / years of data)
        CASE
            WHEN years_of_data >= 10
            THEN ROUND(event_count_10yr_avg / GREATEST(event_count_10yr_avg, 1), 4)
            ELSE NULL
        END AS annual_event_probability,

        -- Frequency trend classification
        CASE
            WHEN years_of_data < 10 THEN 'INSUFFICIENT_DATA'
            WHEN frequency_trend_slope > 0.5 THEN 'INCREASING'
            WHEN frequency_trend_slope < -0.5 THEN 'DECREASING'
            ELSE 'STABLE'
        END AS frequency_trend,

        -- Impact score (0–100): weighted combination of damage, casualties, and frequency
        ROUND(LEAST(100,
            -- Damage component (0–40 points)
            LEAST(40,
                CASE
                    WHEN damage_5yr_avg_usd >= 1000000000 THEN 40  -- $1B+
                    WHEN damage_5yr_avg_usd >= 100000000 THEN 30   -- $100M+
                    WHEN damage_5yr_avg_usd >= 10000000 THEN 20    -- $10M+
                    WHEN damage_5yr_avg_usd >= 1000000 THEN 10     -- $1M+
                    ELSE ROUND(damage_5yr_avg_usd / 100000, 0)     -- Scale linearly
                END
            )
            -- Casualty component (0–40 points)
            + LEAST(40,
                CASE
                    WHEN total_deaths > 10 THEN 40
                    WHEN total_deaths > 0 THEN 30
                    WHEN total_injuries > 50 THEN 20
                    WHEN total_injuries > 0 THEN 10
                    ELSE 0
                END
            )
            -- Frequency component (0–20 points)
            + LEAST(20,
                ROUND(event_count_5yr_avg * 2, 0)
            )
        ), 0) AS impact_score,

        -- Risk category
        CASE
            WHEN total_deaths > 10 OR damage_5yr_avg_usd >= 1000000000 THEN 'EXTREME'
            WHEN total_deaths > 0 OR damage_5yr_avg_usd >= 100000000 THEN 'HIGH'
            WHEN total_injuries > 10 OR damage_5yr_avg_usd >= 10000000 THEN 'MODERATE'
            WHEN event_count_5yr_avg > 5 THEN 'ELEVATED'
            ELSE 'LOW'
        END AS risk_category,

        -- Tornado-specific
        max_ef_rating,

        -- Data quality
        years_of_data,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM rolling_stats
)

SELECT * FROM risk_scoring
WHERE event_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
ORDER BY state, event_type_std, event_season, event_year DESC
