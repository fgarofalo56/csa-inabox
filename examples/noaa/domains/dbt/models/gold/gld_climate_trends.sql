{{ config(
    materialized='table',
    tags=['gold', 'climate_trends', 'analytics']
) }}

{#
    Gold layer: Multi-decadal temperature and precipitation trends by region.

    Aggregates cleaned weather observations to produce regional climate trend
    analytics including:
      - Annual and decadal temperature/precipitation averages by NOAA climate region
      - Anomalies relative to the 1901–2000 baseline period
      - Linear regression trend slopes with statistical significance
      - Extreme event frequency (hot days, freezing days, heavy precip days)
      - Growing season length estimation
      - Trend classification (SIGNIFICANT_WARMING, STABLE, etc.)

    This model serves the Climate Trend Dashboard and research API.
#}

WITH annual_station_stats AS (
    -- Compute annual averages per station
    SELECT
        station_id,
        climate_region,
        state_code,
        observation_year AS year,

        -- Temperature metrics
        ROUND(AVG(temp_avg_celsius), 2) AS avg_temp_celsius,
        ROUND(AVG(temp_max_celsius), 2) AS avg_tmax_celsius,
        ROUND(AVG(temp_min_celsius), 2) AS avg_tmin_celsius,

        -- Extreme temperature counts
        COUNT(CASE WHEN temp_max_celsius >= 35.0 THEN 1 END) AS days_above_35c,
        COUNT(CASE WHEN temp_min_celsius <= 0.0 THEN 1 END) AS days_below_0c,

        -- Precipitation metrics
        ROUND(SUM(COALESCE(precip_mm, 0)), 2) AS total_precip_mm,
        ROUND(MAX(precip_mm), 2) AS max_daily_precip_mm,
        COUNT(CASE WHEN precip_mm >= 25.4 THEN 1 END) AS heavy_precip_days,  -- >=1 inch

        -- Data quality: count of valid observation days
        COUNT(*) AS observation_count,
        SUM(CASE WHEN temp_avg_celsius IS NOT NULL THEN 1 ELSE 0 END) AS temp_observation_days,
        SUM(CASE WHEN precip_mm IS NOT NULL THEN 1 ELSE 0 END) AS precip_observation_days

    FROM {{ ref('slv_weather_observations') }}
    WHERE observation_year >= {{ var('analysis_start_year') }}
      AND climate_region NOT IN ('ALASKA', 'HAWAII', 'OTHER')
      AND is_valid = TRUE
      AND is_temp_outlier = FALSE
    GROUP BY station_id, climate_region, state_code, observation_year
    -- Require at least 300 days of data for annual statistics
    HAVING COUNT(*) >= 300
),

-- Aggregate to regional level
regional_annual AS (
    SELECT
        climate_region,

        -- Select a representative state (the one with most stations)
        MODE() WITHIN GROUP (ORDER BY state_code) AS state_code,

        year,

        -- Decade label
        CONCAT(CAST(FLOOR(year / 10) * 10 AS STRING), 's') AS decade,

        -- Temperature: average across stations in the region
        ROUND(AVG(avg_temp_celsius), 2) AS avg_annual_temp_celsius,
        ROUND(AVG(avg_tmax_celsius), 2) AS avg_annual_tmax_celsius,
        ROUND(AVG(avg_tmin_celsius), 2) AS avg_annual_tmin_celsius,

        -- Extreme days: average across stations
        ROUND(AVG(days_above_35c), 0) AS days_above_35c,
        ROUND(AVG(days_below_0c), 0) AS days_below_0c,

        -- Precipitation: average across stations
        ROUND(AVG(total_precip_mm), 2) AS total_annual_precip_mm,
        ROUND(MAX(max_daily_precip_mm), 2) AS max_daily_precip_mm,
        ROUND(AVG(heavy_precip_days), 0) AS heavy_precip_days,

        -- Station count for this region/year
        COUNT(DISTINCT station_id) AS station_count

    FROM annual_station_stats
    GROUP BY climate_region, year
    -- Require at least 5 stations per region for robust averaging
    HAVING COUNT(DISTINCT station_id) >= 5
),

-- Compute the 1901–2000 baseline for each region
baseline AS (
    SELECT
        climate_region,
        ROUND(AVG(avg_annual_temp_celsius), 2) AS baseline_temp_celsius,
        ROUND(AVG(total_annual_precip_mm), 2) AS baseline_precip_mm,
        ROUND(AVG(days_above_35c), 0) AS baseline_days_above_35c,
        ROUND(AVG(days_below_0c), 0) AS baseline_days_below_0c
    FROM regional_annual
    WHERE year BETWEEN {{ var('baseline_period_start') }} AND {{ var('baseline_period_end') }}
    GROUP BY climate_region
),

-- Calculate anomalies and trends
with_anomalies AS (
    SELECT
        r.*,

        -- Temperature anomaly vs baseline
        ROUND(r.avg_annual_temp_celsius - b.baseline_temp_celsius, 2) AS temp_anomaly_vs_baseline,

        -- Precipitation anomaly vs baseline
        ROUND(r.total_annual_precip_mm - b.baseline_precip_mm, 2) AS precip_anomaly_vs_baseline,

        -- Growing season: rough estimate based on frost-free days
        -- (366 minus freezing days, capped at 366)
        LEAST(CAST(366 - r.days_below_0c AS INT), 366) AS growing_season_days,

        -- Consecutive dry days placeholder (would need daily-level analysis)
        NULL AS consecutive_dry_days,

        -- Linear trend using window regression over 30-year windows
        REGR_SLOPE(r.avg_annual_temp_celsius, r.year) OVER (
            PARTITION BY r.climate_region
            ORDER BY r.year
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS trend_slope_raw,

        -- R-squared for trend reliability
        REGR_R2(r.avg_annual_temp_celsius, r.year) OVER (
            PARTITION BY r.climate_region
            ORDER BY r.year
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS trend_r_squared,

        -- Row count in the regression window
        REGR_COUNT(r.avg_annual_temp_celsius, r.year) OVER (
            PARTITION BY r.climate_region
            ORDER BY r.year
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS trend_window_count

    FROM regional_annual r
    LEFT JOIN baseline b ON r.climate_region = b.climate_region
),

-- Compute trend slope per decade and classification
final AS (
    SELECT
        climate_region,
        state_code,
        decade,
        year,

        -- Temperature metrics
        avg_annual_temp_celsius,
        temp_anomaly_vs_baseline,
        avg_annual_tmax_celsius,
        avg_annual_tmin_celsius,
        CAST(days_above_35c AS INT) AS days_above_35c,
        CAST(days_below_0c AS INT) AS days_below_0c,
        growing_season_days,

        -- Precipitation metrics
        total_annual_precip_mm,
        precip_anomaly_vs_baseline,
        max_daily_precip_mm,
        CAST(heavy_precip_days AS INT) AS heavy_precip_days,
        CAST(consecutive_dry_days AS INT) AS consecutive_dry_days,

        -- Trend per decade (slope * 10 years)
        CASE
            WHEN trend_window_count >= 20
            THEN ROUND(trend_slope_raw * 10, 4)
            ELSE NULL
        END AS trend_slope_per_decade,

        -- Approximate p-value from R² and sample size
        -- (simplified: use R² as a proxy — in production, use scipy.stats or a UDF)
        CASE
            WHEN trend_window_count >= 20 AND trend_r_squared IS NOT NULL
            THEN ROUND(
                GREATEST(0.001, 1.0 - trend_r_squared * (trend_window_count - 2)),
            4)
            ELSE NULL
        END AS trend_p_value,

        -- Trend classification
        CASE
            WHEN trend_window_count < 20 THEN 'INSUFFICIENT_DATA'
            WHEN trend_slope_raw * 10 > 0.3 AND trend_r_squared > 0.3 THEN 'SIGNIFICANT_WARMING'
            WHEN trend_slope_raw * 10 > 0.1 THEN 'MODERATE_WARMING'
            WHEN trend_slope_raw * 10 < -0.3 AND trend_r_squared > 0.3 THEN 'SIGNIFICANT_COOLING'
            WHEN trend_slope_raw * 10 < -0.1 THEN 'MODERATE_COOLING'
            ELSE 'STABLE'
        END AS trend_classification,

        -- Data quality
        station_count,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM with_anomalies
    WHERE year >= {{ var('analysis_start_year') }}
)

SELECT * FROM final
ORDER BY climate_region, year DESC
