{{ config(
    materialized='table',
    tags=['gold', 'aqi_forecast', 'analytics', 'ml']
) }}

{#
    Gold layer: AQI prediction features and historical patterns.

    Produces feature-engineered data for ML-based AQI forecasting including:
      - Historical AQI patterns by site, pollutant, and season
      - Lag features (1-day, 3-day, 7-day rolling averages)
      - Seasonal decomposition (day-of-week, month, season effects)
      - Exceedance frequency and consecutive bad air day tracking
      - Year-over-year trend and anomaly detection
      - Site-level prediction performance metrics (when actuals available)

    This model serves as both an analytical product and a feature store
    for the AQI prediction ML pipeline.
#}

WITH daily_site_aqi AS (
    -- Get the dominant pollutant AQI per site per day
    SELECT
        site_id,
        state_code,
        county_code,
        cbsa_name,
        latitude,
        longitude,
        observation_date,
        observation_year,
        observation_month,

        -- Dominant pollutant: the one with the highest AQI on this day
        FIRST_VALUE(pollutant) OVER (
            PARTITION BY site_id, observation_date
            ORDER BY aqi_value DESC
        ) AS dominant_pollutant,

        -- Site-level AQI is the max across all pollutants
        MAX(aqi_value) OVER (
            PARTITION BY site_id, observation_date
        ) AS daily_aqi,

        -- Individual pollutant AQIs
        MAX(CASE WHEN pollutant = 'PM2.5' THEN aqi_value END) OVER (
            PARTITION BY site_id, observation_date
        ) AS aqi_pm25,
        MAX(CASE WHEN pollutant = 'O3' THEN aqi_value END) OVER (
            PARTITION BY site_id, observation_date
        ) AS aqi_ozone,
        MAX(CASE WHEN pollutant = 'NO2' THEN aqi_value END) OVER (
            PARTITION BY site_id, observation_date
        ) AS aqi_no2,
        MAX(CASE WHEN pollutant = 'CO' THEN aqi_value END) OVER (
            PARTITION BY site_id, observation_date
        ) AS aqi_co,

        -- Max concentration for dominant pollutant
        MAX(CASE WHEN pollutant = 'PM2.5' THEN concentration END) OVER (
            PARTITION BY site_id, observation_date
        ) AS pm25_concentration,
        MAX(CASE WHEN pollutant = 'O3' THEN concentration END) OVER (
            PARTITION BY site_id, observation_date
        ) AS ozone_concentration,

        -- AQI category for the day
        MAX(aqi_category) OVER (
            PARTITION BY site_id, observation_date
        ) AS aqi_category,

        -- Data quality
        AVG(data_quality_score) OVER (
            PARTITION BY site_id, observation_date
        ) AS avg_data_quality,

        ROW_NUMBER() OVER (
            PARTITION BY site_id, observation_date
            ORDER BY aqi_value DESC
        ) AS rn

    FROM {{ ref('slv_air_quality') }}
    WHERE observation_year >= {{ var('aqi_baseline_period_start') }}
),

-- Deduplicate to one row per site per day
daily_deduped AS (
    SELECT * FROM daily_site_aqi WHERE rn = 1
),

-- Calculate lag features for ML prediction
with_lag_features AS (
    SELECT
        *,

        -- Day-of-week and seasonal features
        DAYOFWEEK(observation_date) AS day_of_week,
        CASE
            WHEN observation_month IN (12, 1, 2) THEN 'WINTER'
            WHEN observation_month IN (3, 4, 5) THEN 'SPRING'
            WHEN observation_month IN (6, 7, 8) THEN 'SUMMER'
            WHEN observation_month IN (9, 10, 11) THEN 'FALL'
        END AS season,

        -- Lag features: previous days' AQI
        LAG(daily_aqi, 1) OVER w AS aqi_lag_1d,
        LAG(daily_aqi, 2) OVER w AS aqi_lag_2d,
        LAG(daily_aqi, 3) OVER w AS aqi_lag_3d,
        LAG(daily_aqi, 7) OVER w AS aqi_lag_7d,

        -- Rolling averages
        AVG(daily_aqi) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) AS aqi_3d_rolling_avg,

        AVG(daily_aqi) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS aqi_7d_rolling_avg,

        AVG(daily_aqi) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS aqi_30d_rolling_avg,

        -- Rolling max
        MAX(daily_aqi) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS aqi_7d_max,

        -- Rolling standard deviation (volatility)
        STDDEV(daily_aqi) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS aqi_30d_stddev,

        -- Day-over-day change
        daily_aqi - LAG(daily_aqi, 1) OVER w AS aqi_change_1d,

        -- Exceedance flags
        CASE WHEN daily_aqi > 100 THEN 1 ELSE 0 END AS exceeds_usg_threshold,
        CASE WHEN daily_aqi > 150 THEN 1 ELSE 0 END AS exceeds_unhealthy_threshold,

        -- Consecutive bad air days (AQI > 100)
        SUM(CASE WHEN daily_aqi > 100 THEN 1 ELSE 0 END) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ) AS bad_air_days_7d,

        SUM(CASE WHEN daily_aqi > 100 THEN 1 ELSE 0 END) OVER (
            PARTITION BY site_id
            ORDER BY observation_date
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS bad_air_days_30d

    FROM daily_deduped
    WINDOW w AS (PARTITION BY site_id ORDER BY observation_date)
),

-- Compute seasonal baseline and anomalies
with_baseline AS (
    SELECT
        f.*,

        -- Monthly climatological mean for this site
        AVG(f.daily_aqi) OVER (
            PARTITION BY f.site_id, f.observation_month
            ORDER BY f.observation_date
            ROWS BETWEEN 365 * 3 PRECEDING AND 1 PRECEDING  -- ~3-year baseline
        ) AS monthly_baseline_aqi,

        -- Anomaly: deviation from monthly baseline
        f.daily_aqi - AVG(f.daily_aqi) OVER (
            PARTITION BY f.site_id, f.observation_month
            ORDER BY f.observation_date
            ROWS BETWEEN 365 * 3 PRECEDING AND 1 PRECEDING
        ) AS aqi_anomaly_vs_baseline,

        -- Year-over-year trend (same month, previous year)
        LAG(f.daily_aqi, 365) OVER (
            PARTITION BY f.site_id
            ORDER BY f.observation_date
        ) AS aqi_same_day_prev_year

    FROM with_lag_features f
),

-- Final output with prediction-ready features
final AS (
    SELECT
        -- Identifiers
        site_id,
        state_code,
        county_code,
        cbsa_name,
        latitude,
        longitude,
        observation_date,
        observation_year,
        observation_month,
        day_of_week,
        season,

        -- Current AQI
        daily_aqi,
        dominant_pollutant,
        aqi_category,
        aqi_pm25,
        aqi_ozone,
        aqi_no2,
        pm25_concentration,
        ozone_concentration,

        -- Lag features (for ML input)
        ROUND(aqi_lag_1d, 1) AS aqi_lag_1d,
        ROUND(aqi_lag_2d, 1) AS aqi_lag_2d,
        ROUND(aqi_lag_3d, 1) AS aqi_lag_3d,
        ROUND(aqi_lag_7d, 1) AS aqi_lag_7d,

        -- Rolling statistics
        ROUND(aqi_3d_rolling_avg, 1) AS aqi_3d_rolling_avg,
        ROUND(aqi_7d_rolling_avg, 1) AS aqi_7d_rolling_avg,
        ROUND(aqi_30d_rolling_avg, 1) AS aqi_30d_rolling_avg,
        aqi_7d_max,
        ROUND(aqi_30d_stddev, 1) AS aqi_30d_volatility,

        -- Change and momentum
        aqi_change_1d,

        -- Exceedance tracking
        exceeds_usg_threshold,
        exceeds_unhealthy_threshold,
        bad_air_days_7d,
        bad_air_days_30d,

        -- Baseline and anomaly
        ROUND(monthly_baseline_aqi, 1) AS monthly_baseline_aqi,
        ROUND(aqi_anomaly_vs_baseline, 1) AS aqi_anomaly_vs_baseline,

        -- YoY comparison
        aqi_same_day_prev_year,
        CASE
            WHEN aqi_same_day_prev_year IS NOT NULL AND aqi_same_day_prev_year > 0
            THEN ROUND((daily_aqi - aqi_same_day_prev_year) / aqi_same_day_prev_year * 100, 1)
            ELSE NULL
        END AS aqi_yoy_change_pct,

        -- Health advisory summary
        CASE
            WHEN daily_aqi <= 50 THEN 'No advisory needed'
            WHEN daily_aqi <= 100 THEN 'Unusually sensitive individuals should limit outdoor exertion'
            WHEN daily_aqi <= 150 THEN 'Sensitive groups should reduce prolonged outdoor exertion'
            WHEN daily_aqi <= 200 THEN 'Everyone should reduce prolonged outdoor exertion'
            WHEN daily_aqi <= 300 THEN 'Everyone should avoid all outdoor exertion'
            ELSE 'EMERGENCY: Remain indoors'
        END AS health_advisory,

        -- Data quality
        ROUND(avg_data_quality, 2) AS data_quality_score,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM with_baseline
    WHERE observation_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
)

SELECT * FROM final
ORDER BY site_id, observation_date DESC
