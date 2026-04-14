{{ config(
    materialized='table',
    tags=['gold', 'safety', 'hotspots', 'analytics']
) }}

/*
    Gold Layer: Safety Hotspot Analysis
    Description: Aggregated crash hotspot analysis with severity-weighted scores,
                 year-over-year trends, and contributing factor breakdown. Crashes
                 are clustered by grid cell (0.1-degree squares) and optionally
                 by named corridor.

    Business Use Cases:
      - Identify the most dangerous road segments for targeted interventions
      - Track year-over-year trends in crash frequency and severity
      - Analyze contributing factors (alcohol, weather, time-of-day)
      - Support federal highway safety improvement program (HSIP) allocation
*/

WITH crash_base AS (
    SELECT
        crash_sk,
        case_id,
        state_code,
        state_fips,
        county_code,
        crash_year,
        crash_month,
        crash_date,
        time_of_day_bucket,
        day_of_week_name,
        weather_category,
        light_category,
        manner_of_collision,
        road_function_class,
        rural_urban,
        fatality_count,
        drunk_driver_count,
        total_persons,
        total_vehicles,
        pedestrians_involved,
        severity_score,
        is_alcohol_related,
        is_pedestrian_involved,
        is_nighttime,
        grid_cell_id,
        latitude,
        longitude,
        has_valid_coordinates,
        posted_speed_limit
    FROM {{ ref('slv_crash_data') }}
    WHERE crash_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years') }}
),

-- Aggregate by grid cell and year for hotspot detection
grid_cell_stats AS (
    SELECT
        grid_cell_id,
        state_code,
        crash_year AS analysis_year,

        -- Crash counts
        COUNT(DISTINCT case_id) AS total_crashes,
        SUM(fatality_count) AS total_fatalities,
        SUM(total_persons) AS total_persons_involved,
        SUM(total_vehicles) AS total_vehicles_involved,

        -- Severity metrics
        SUM(severity_score) AS severity_weighted_score,
        ROUND(AVG(severity_score), 2) AS avg_severity_score,
        MAX(severity_score) AS max_severity_score,

        -- Geographic center of cluster
        ROUND(AVG(latitude), 6) AS cluster_center_lat,
        ROUND(AVG(longitude), 6) AS cluster_center_lon,

        -- Contributing factor counts
        SUM(CASE WHEN is_alcohol_related THEN 1 ELSE 0 END) AS alcohol_related_crashes,
        SUM(CASE WHEN is_pedestrian_involved THEN 1 ELSE 0 END) AS pedestrian_crashes,
        SUM(CASE WHEN is_nighttime THEN 1 ELSE 0 END) AS nighttime_crashes,
        SUM(CASE WHEN weather_category NOT IN ('CLEAR', 'CLOUDY', 'UNKNOWN') THEN 1 ELSE 0 END) AS adverse_weather_crashes,

        -- Contributing factor percentages
        ROUND(
            SUM(CASE WHEN is_alcohol_related THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
        , 1) AS alcohol_related_pct,
        ROUND(
            SUM(CASE WHEN is_pedestrian_involved THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
        , 1) AS pedestrian_pct,
        ROUND(
            SUM(CASE WHEN is_nighttime THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
        , 1) AS nighttime_pct,
        ROUND(
            SUM(CASE WHEN weather_category NOT IN ('CLEAR', 'CLOUDY', 'UNKNOWN') THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0)
        , 1) AS adverse_weather_pct,

        -- Top contributing factor
        CASE
            WHEN SUM(CASE WHEN is_alcohol_related THEN 1 ELSE 0 END) >=
                 GREATEST(
                     SUM(CASE WHEN is_pedestrian_involved THEN 1 ELSE 0 END),
                     SUM(CASE WHEN is_nighttime THEN 1 ELSE 0 END),
                     SUM(CASE WHEN weather_category NOT IN ('CLEAR', 'CLOUDY', 'UNKNOWN') THEN 1 ELSE 0 END)
                 ) THEN 'ALCOHOL'
            WHEN SUM(CASE WHEN weather_category NOT IN ('CLEAR', 'CLOUDY', 'UNKNOWN') THEN 1 ELSE 0 END) >=
                 GREATEST(
                     SUM(CASE WHEN is_pedestrian_involved THEN 1 ELSE 0 END),
                     SUM(CASE WHEN is_nighttime THEN 1 ELSE 0 END)
                 ) THEN 'ADVERSE_WEATHER'
            WHEN SUM(CASE WHEN is_nighttime THEN 1 ELSE 0 END) >=
                 SUM(CASE WHEN is_pedestrian_involved THEN 1 ELSE 0 END)
            THEN 'NIGHTTIME'
            ELSE 'PEDESTRIAN'
        END AS top_contributing_factor,

        -- Time pattern analysis
        MODE(time_of_day_bucket) AS peak_time_bucket,
        MODE(day_of_week_name) AS peak_day_of_week,
        MODE(road_function_class) AS predominant_road_class,
        MODE(rural_urban) AS area_type,

        -- Speed analysis
        ROUND(AVG(CASE WHEN posted_speed_limit > 0 THEN posted_speed_limit END), 0) AS avg_speed_limit

    FROM crash_base
    WHERE grid_cell_id IS NOT NULL
    GROUP BY grid_cell_id, state_code, crash_year
),

-- Calculate year-over-year trends
with_trends AS (
    SELECT
        g.*,

        -- Previous year metrics for trend calculation
        LAG(total_crashes, 1) OVER (
            PARTITION BY grid_cell_id, state_code
            ORDER BY analysis_year
        ) AS crashes_prev_year,

        LAG(total_fatalities, 1) OVER (
            PARTITION BY grid_cell_id, state_code
            ORDER BY analysis_year
        ) AS fatalities_prev_year,

        LAG(severity_weighted_score, 1) OVER (
            PARTITION BY grid_cell_id, state_code
            ORDER BY analysis_year
        ) AS severity_score_prev_year,

        -- 3-year average for stable comparison
        AVG(total_crashes) OVER (
            PARTITION BY grid_cell_id, state_code
            ORDER BY analysis_year
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) AS crashes_3yr_avg,

        AVG(severity_weighted_score) OVER (
            PARTITION BY grid_cell_id, state_code
            ORDER BY analysis_year
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) AS severity_3yr_avg

    FROM grid_cell_stats g
),

-- Final output with YoY calculations and ranking
final AS (
    SELECT
        -- Identifiers
        grid_cell_id,
        state_code,
        analysis_year,

        -- Crash metrics
        total_crashes,
        total_fatalities,
        total_persons_involved,
        total_vehicles_involved,

        -- Severity
        ROUND(severity_weighted_score, 2) AS severity_weighted_score,
        avg_severity_score,
        max_severity_score,

        -- Geographic center
        cluster_center_lat,
        cluster_center_lon,

        -- Contributing factors
        alcohol_related_crashes,
        pedestrian_crashes,
        nighttime_crashes,
        adverse_weather_crashes,
        alcohol_related_pct,
        pedestrian_pct,
        nighttime_pct,
        adverse_weather_pct,
        top_contributing_factor,

        -- Patterns
        peak_time_bucket,
        peak_day_of_week,
        predominant_road_class,
        area_type,
        avg_speed_limit,

        -- Year-over-year changes
        CASE
            WHEN crashes_prev_year IS NOT NULL AND crashes_prev_year > 0
            THEN ROUND((total_crashes - crashes_prev_year) * 100.0 / crashes_prev_year, 1)
            ELSE NULL
        END AS crashes_yoy_change_pct,

        CASE
            WHEN fatalities_prev_year IS NOT NULL AND fatalities_prev_year > 0
            THEN ROUND((total_fatalities - fatalities_prev_year) * 100.0 / fatalities_prev_year, 1)
            ELSE NULL
        END AS fatalities_yoy_change_pct,

        -- Trend classification
        CASE
            WHEN crashes_prev_year IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN total_crashes > crashes_prev_year * 1.1 THEN 'WORSENING'
            WHEN total_crashes < crashes_prev_year * 0.9 THEN 'IMPROVING'
            ELSE 'STABLE'
        END AS crash_trend,

        -- Moving averages
        ROUND(crashes_3yr_avg, 1) AS crashes_3yr_avg,
        ROUND(severity_3yr_avg, 1) AS severity_3yr_avg,

        -- Hotspot ranking within state
        ROW_NUMBER() OVER (
            PARTITION BY state_code, analysis_year
            ORDER BY severity_weighted_score DESC
        ) AS state_hotspot_rank,

        -- National ranking
        ROW_NUMBER() OVER (
            PARTITION BY analysis_year
            ORDER BY severity_weighted_score DESC
        ) AS national_hotspot_rank,

        -- Hotspot tier classification
        CASE
            WHEN severity_weighted_score >= PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY severity_weighted_score)
                 OVER (PARTITION BY analysis_year) THEN 'TIER_1_CRITICAL'
            WHEN severity_weighted_score >= PERCENTILE_CONT(0.85) WITHIN GROUP (ORDER BY severity_weighted_score)
                 OVER (PARTITION BY analysis_year) THEN 'TIER_2_HIGH'
            WHEN severity_weighted_score >= PERCENTILE_CONT(0.70) WITHIN GROUP (ORDER BY severity_weighted_score)
                 OVER (PARTITION BY analysis_year) THEN 'TIER_3_ELEVATED'
            ELSE 'TIER_4_STANDARD'
        END AS hotspot_tier,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM with_trends
)

SELECT * FROM final
ORDER BY analysis_year DESC, severity_weighted_score DESC
