{{ config(
    materialized='table',
    tags=['gold', 'marine_ecosystem', 'analytics']
) }}

{#
    Gold layer: Composite marine ecosystem health index.

    Combines cleaned ocean buoy observations to produce a multi-factor
    marine ecosystem health assessment for each marine region, including:
      - Sea surface temperature anomaly and trend
      - Salinity index and variability
      - Wave energy and ocean circulation indicators
      - Degree Heating Weeks (DHW) for coral bleaching risk
      - Composite health score (0–100) aggregating all factors
      - Inter-annual comparison and trend direction

    This model serves the Marine Health Reports and research APIs.
#}

WITH monthly_buoy_stats AS (
    -- Aggregate buoy observations to monthly summaries
    SELECT
        station_id,
        marine_region,
        observation_year,
        observation_month,

        -- Sea surface temperature statistics
        ROUND(AVG(sea_surface_temp_c), 2) AS avg_sst_c,
        ROUND(MIN(sea_surface_temp_c), 2) AS min_sst_c,
        ROUND(MAX(sea_surface_temp_c), 2) AS max_sst_c,
        ROUND(STDDEV(sea_surface_temp_c), 2) AS sst_stddev,
        ROUND(AVG(sst_anomaly_c), 2) AS avg_sst_anomaly_c,

        -- Salinity statistics
        ROUND(AVG(salinity_psu), 2) AS avg_salinity_psu,
        ROUND(STDDEV(salinity_psu), 2) AS salinity_stddev,

        -- Wave statistics
        ROUND(AVG(wave_height_m), 2) AS avg_wave_height_m,
        ROUND(MAX(wave_height_m), 2) AS max_wave_height_m,
        ROUND(AVG(dominant_wave_period_s), 1) AS avg_wave_period_s,

        -- Wind statistics
        ROUND(AVG(wind_speed_ms), 2) AS avg_wind_speed_ms,
        ROUND(MAX(wind_speed_ms), 2) AS max_wind_speed_ms,

        -- Ocean current statistics
        ROUND(AVG(ocean_current_speed_ms), 2) AS avg_current_speed_ms,

        -- Atmospheric
        ROUND(AVG(air_temperature_c), 2) AS avg_air_temp_c,
        ROUND(AVG(pressure_hpa), 1) AS avg_pressure_hpa,

        -- Data quality
        COUNT(*) AS observation_count,
        ROUND(AVG(data_completeness_score), 2) AS avg_completeness

    FROM {{ ref('slv_ocean_observations') }}
    WHERE is_valid = TRUE
      AND marine_region != 'OTHER'
      AND observation_year >= {{ var('analysis_start_year') }}
    GROUP BY station_id, marine_region, observation_year, observation_month
    HAVING COUNT(*) >= 20  -- Require at least 20 observations per month
),

-- Aggregate to regional monthly level
regional_monthly AS (
    SELECT
        marine_region,
        observation_year,
        observation_month,

        -- SST: regional average
        ROUND(AVG(avg_sst_c), 2) AS regional_avg_sst_c,
        ROUND(AVG(avg_sst_anomaly_c), 2) AS regional_sst_anomaly_c,
        ROUND(MAX(max_sst_c), 2) AS regional_max_sst_c,
        ROUND(AVG(sst_stddev), 2) AS regional_sst_variability,

        -- Salinity: regional average
        ROUND(AVG(avg_salinity_psu), 2) AS regional_avg_salinity_psu,
        ROUND(AVG(salinity_stddev), 2) AS regional_salinity_variability,

        -- Waves
        ROUND(AVG(avg_wave_height_m), 2) AS regional_avg_wave_height_m,
        ROUND(MAX(max_wave_height_m), 2) AS regional_max_wave_height_m,

        -- Currents
        ROUND(AVG(avg_current_speed_ms), 2) AS regional_avg_current_ms,

        -- Station coverage
        COUNT(DISTINCT station_id) AS active_buoys,
        ROUND(AVG(avg_completeness), 2) AS data_completeness

    FROM monthly_buoy_stats
    GROUP BY marine_region, observation_year, observation_month
),

-- Calculate Maximum Monthly Mean (MMM) SST for coral bleaching
mmm_sst AS (
    SELECT
        marine_region,
        observation_month,
        ROUND(AVG(regional_avg_sst_c), 2) AS mmm_sst_c
    FROM regional_monthly
    WHERE observation_year BETWEEN 1985 AND 2012  -- Coral bleaching baseline period
    GROUP BY marine_region, observation_month
),

-- Compute Degree Heating Weeks (DHW) and annual health metrics
annual_health AS (
    SELECT
        r.marine_region,
        r.observation_year AS assessment_year,

        -- SST metrics
        ROUND(AVG(r.regional_avg_sst_c), 2) AS avg_annual_sst_c,
        ROUND(AVG(r.regional_sst_anomaly_c), 2) AS sea_surface_temp_anomaly_c,
        ROUND(MAX(r.regional_max_sst_c), 2) AS max_sst_c,

        -- Salinity index: normalized around 35 PSU (typical ocean)
        ROUND(AVG(r.regional_avg_salinity_psu), 2) AS avg_salinity_psu,
        ROUND(
            CASE
                WHEN AVG(r.regional_avg_salinity_psu) IS NULL THEN NULL
                ELSE 1.0 - ABS(AVG(r.regional_avg_salinity_psu) - 35.0) / 5.0
            END
        , 2) AS salinity_index,  -- 1.0 = ideal, lower = deviation

        -- Wave energy proxy
        ROUND(AVG(r.regional_avg_wave_height_m), 2) AS avg_wave_height_m,

        -- Chlorophyll proxy: use SST variability as a rough proxy
        -- (In production, ingest satellite chlorophyll-a data from ERDDAP)
        ROUND(AVG(r.regional_sst_variability), 2) AS sst_variability,

        -- Degree Heating Weeks: cumulative weekly SST exceedance above MMM
        ROUND(
            SUM(
                CASE
                    WHEN r.regional_avg_sst_c > m.mmm_sst_c + {{ var('coral_bleaching_sst_threshold') }}
                    THEN (r.regional_avg_sst_c - m.mmm_sst_c) / 4.0  -- Monthly → weekly
                    ELSE 0
                END
            )
        , 2) AS degree_heating_weeks,

        -- Coral bleaching risk category
        CASE
            WHEN SUM(
                CASE
                    WHEN r.regional_avg_sst_c > m.mmm_sst_c + {{ var('coral_bleaching_sst_threshold') }}
                    THEN (r.regional_avg_sst_c - m.mmm_sst_c) / 4.0
                    ELSE 0
                END
            ) >= {{ var('degree_heating_weeks_critical') }} THEN 'BLEACHING_LIKELY'
            WHEN SUM(
                CASE
                    WHEN r.regional_avg_sst_c > m.mmm_sst_c + {{ var('coral_bleaching_sst_threshold') }}
                    THEN (r.regional_avg_sst_c - m.mmm_sst_c) / 4.0
                    ELSE 0
                END
            ) >= {{ var('degree_heating_weeks_alert') }} THEN 'BLEACHING_WATCH'
            WHEN AVG(r.regional_sst_anomaly_c) > 0.5 THEN 'THERMAL_STRESS'
            ELSE 'NO_STRESS'
        END AS coral_bleaching_risk,

        -- Fish stock health index placeholder (in production, join NMFS survey data)
        -- For now, derive from environmental conditions
        ROUND(
            CASE
                WHEN ABS(AVG(r.regional_sst_anomaly_c)) < 0.5
                     AND AVG(r.regional_avg_salinity_psu) BETWEEN 33 AND 37
                THEN 0.8  -- Good conditions
                WHEN ABS(AVG(r.regional_sst_anomaly_c)) < 1.0 THEN 0.6
                WHEN ABS(AVG(r.regional_sst_anomaly_c)) < 2.0 THEN 0.4
                ELSE 0.2  -- Stressed conditions
            END
        , 2) AS fish_stock_health_index,

        -- Data quality
        ROUND(AVG(r.data_completeness), 2) AS data_completeness,
        ROUND(AVG(r.active_buoys), 0) AS avg_active_buoys

    FROM regional_monthly r
    LEFT JOIN mmm_sst m
        ON r.marine_region = m.marine_region
        AND r.observation_month = m.observation_month
    GROUP BY r.marine_region, r.observation_year
    HAVING COUNT(*) >= 6  -- Require at least 6 months of data
),

-- Compute composite health score and trends
composite AS (
    SELECT
        *,

        -- Composite Health Score (0–100):
        -- Higher = healthier ecosystem
        ROUND(LEAST(100, GREATEST(0,
            -- SST stability component (0–30 points): penalize large anomalies
            LEAST(30,
                CASE
                    WHEN ABS(sea_surface_temp_anomaly_c) < 0.25 THEN 30
                    WHEN ABS(sea_surface_temp_anomaly_c) < 0.5 THEN 25
                    WHEN ABS(sea_surface_temp_anomaly_c) < 1.0 THEN 15
                    WHEN ABS(sea_surface_temp_anomaly_c) < 2.0 THEN 5
                    ELSE 0
                END
            )
            -- Salinity component (0–20 points)
            + LEAST(20,
                ROUND(COALESCE(salinity_index, 0.5) * 20, 0)
            )
            -- Coral risk component (0–25 points): penalize bleaching risk
            + CASE
                WHEN coral_bleaching_risk = 'NO_STRESS' THEN 25
                WHEN coral_bleaching_risk = 'THERMAL_STRESS' THEN 15
                WHEN coral_bleaching_risk = 'BLEACHING_WATCH' THEN 5
                ELSE 0
            END
            -- Fish stock component (0–25 points)
            + ROUND(COALESCE(fish_stock_health_index, 0.5) * 25, 0)
        )), 0) AS composite_health_score,

        -- Year-over-year SST anomaly change
        sea_surface_temp_anomaly_c - LAG(sea_surface_temp_anomaly_c, 1) OVER (
            PARTITION BY marine_region
            ORDER BY assessment_year
        ) AS sst_anomaly_yoy_change,

        -- 5-year trend in composite health
        REGR_SLOPE(
            -- Can't use composite_health_score here yet, so repeat the calculation
            LEAST(100, GREATEST(0,
                CASE WHEN ABS(sea_surface_temp_anomaly_c) < 0.25 THEN 30
                     WHEN ABS(sea_surface_temp_anomaly_c) < 0.5 THEN 25
                     WHEN ABS(sea_surface_temp_anomaly_c) < 1.0 THEN 15
                     ELSE 5 END
                + COALESCE(salinity_index, 0.5) * 20
                + COALESCE(fish_stock_health_index, 0.5) * 25
            )),
            assessment_year
        ) OVER (
            PARTITION BY marine_region
            ORDER BY assessment_year
            ROWS BETWEEN 4 PRECEDING AND CURRENT ROW
        ) AS health_trend_slope

    FROM annual_health
),

final AS (
    SELECT
        marine_region,
        assessment_year,

        -- SST metrics
        avg_annual_sst_c,
        sea_surface_temp_anomaly_c,
        max_sst_c,
        ROUND(sst_anomaly_yoy_change, 2) AS sst_anomaly_yoy_change,

        -- Salinity
        avg_salinity_psu,
        salinity_index,

        -- Wave conditions
        avg_wave_height_m,

        -- Biological indicators
        sst_variability AS chlorophyll_proxy,
        fish_stock_health_index,

        -- Coral bleaching
        degree_heating_weeks,
        coral_bleaching_risk,

        -- Composite score
        CAST(composite_health_score AS INT) AS composite_health_score,

        -- Health classification
        CASE
            WHEN composite_health_score >= 80 THEN 'EXCELLENT'
            WHEN composite_health_score >= 60 THEN 'GOOD'
            WHEN composite_health_score >= 40 THEN 'FAIR'
            WHEN composite_health_score >= 20 THEN 'POOR'
            ELSE 'CRITICAL'
        END AS health_classification,

        -- Trend direction
        CASE
            WHEN health_trend_slope IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN health_trend_slope > 1.0 THEN 'IMPROVING'
            WHEN health_trend_slope < -1.0 THEN 'DECLINING'
            ELSE 'STABLE'
        END AS health_trend,

        -- Data quality
        data_completeness,
        CAST(avg_active_buoys AS INT) AS active_buoys,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM composite
)

SELECT * FROM final
ORDER BY marine_region, assessment_year DESC
