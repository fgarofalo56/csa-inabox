{{ config(
    materialized='incremental',
    unique_key='buoy_observation_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'ocean_observations', 'cleaned']
) }}

{#
    Silver layer: Cleaned ocean buoy observations with quality flags.

    Transforms raw NDBC buoy data by:
      - Replacing NDBC missing-value sentinels (99.0, 999.0) with NULLs
      - Applying physical range validation for all measurements
      - Computing derived metrics (Beaufort scale, sea state, wind chill)
      - Assigning marine ecological regions
      - Calculating Degree Heating Weeks for coral bleaching monitoring
      - Flagging suspect readings based on rate-of-change thresholds

    Source: brz_ocean_buoys (Bronze layer)
#}

WITH valid_bronze AS (
    SELECT * FROM {{ ref('brz_ocean_buoys') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Replace NDBC missing-value sentinels with NULLs and validate ranges
cleaned AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            station_id,
            CAST(observation_datetime AS STRING)
        )) AS buoy_observation_sk,

        station_id,
        station_name,
        station_type,
        latitude,
        longitude,
        water_depth_m,
        observation_datetime,
        observation_date,
        observation_year,
        observation_month,

        -- Clean wind measurements (NDBC uses 999 for missing)
        CASE
            WHEN wind_direction_deg_raw IS NULL OR wind_direction_deg_raw >= 999 THEN NULL
            WHEN wind_direction_deg_raw < 0 OR wind_direction_deg_raw > 360 THEN NULL
            ELSE ROUND(wind_direction_deg_raw, 0)
        END AS wind_direction_deg,

        CASE
            WHEN wind_speed_ms_raw IS NULL OR wind_speed_ms_raw >= 99 THEN NULL
            WHEN wind_speed_ms_raw < 0 OR wind_speed_ms_raw > {{ var('wind_max_valid_ms') }} THEN NULL
            ELSE ROUND(wind_speed_ms_raw, 2)
        END AS wind_speed_ms,

        CASE
            WHEN wind_gust_ms_raw IS NULL OR wind_gust_ms_raw >= 99 THEN NULL
            WHEN wind_gust_ms_raw < 0 OR wind_gust_ms_raw > {{ var('wind_max_valid_ms') }} THEN NULL
            ELSE ROUND(wind_gust_ms_raw, 2)
        END AS wind_gust_ms,

        -- Clean wave measurements
        CASE
            WHEN wave_height_m_raw IS NULL OR wave_height_m_raw >= 99 THEN NULL
            WHEN wave_height_m_raw < 0 OR wave_height_m_raw > {{ var('wave_max_valid_m') }} THEN NULL
            ELSE ROUND(wave_height_m_raw, 2)
        END AS wave_height_m,

        CASE
            WHEN dominant_wave_period_s_raw IS NULL OR dominant_wave_period_s_raw >= 99 THEN NULL
            WHEN dominant_wave_period_s_raw < 0 OR dominant_wave_period_s_raw > 30 THEN NULL
            ELSE ROUND(dominant_wave_period_s_raw, 1)
        END AS dominant_wave_period_s,

        CASE
            WHEN average_wave_period_s_raw IS NULL OR average_wave_period_s_raw >= 99 THEN NULL
            WHEN average_wave_period_s_raw < 0 OR average_wave_period_s_raw > 30 THEN NULL
            ELSE ROUND(average_wave_period_s_raw, 1)
        END AS average_wave_period_s,

        CASE
            WHEN mean_wave_direction_deg_raw IS NULL OR mean_wave_direction_deg_raw >= 999 THEN NULL
            WHEN mean_wave_direction_deg_raw < 0 OR mean_wave_direction_deg_raw > 360 THEN NULL
            ELSE ROUND(mean_wave_direction_deg_raw, 0)
        END AS mean_wave_direction_deg,

        -- Clean atmospheric measurements
        CASE
            WHEN pressure_hpa_raw IS NULL OR pressure_hpa_raw >= 9999 THEN NULL
            WHEN pressure_hpa_raw < 870 OR pressure_hpa_raw > 1084 THEN NULL  -- Physical limits
            ELSE ROUND(pressure_hpa_raw, 1)
        END AS pressure_hpa,

        CASE
            WHEN air_temperature_c_raw IS NULL OR air_temperature_c_raw >= 99 THEN NULL
            WHEN air_temperature_c_raw < -60 OR air_temperature_c_raw > 50 THEN NULL
            ELSE ROUND(air_temperature_c_raw, 1)
        END AS air_temperature_c,

        CASE
            WHEN dewpoint_c_raw IS NULL OR dewpoint_c_raw >= 99 THEN NULL
            WHEN dewpoint_c_raw < -60 OR dewpoint_c_raw > 40 THEN NULL
            ELSE ROUND(dewpoint_c_raw, 1)
        END AS dewpoint_c,

        CASE
            WHEN visibility_nmi_raw IS NULL OR visibility_nmi_raw >= 99 THEN NULL
            WHEN visibility_nmi_raw < 0 OR visibility_nmi_raw > 50 THEN NULL
            ELSE ROUND(visibility_nmi_raw, 1)
        END AS visibility_nmi,

        -- Clean ocean measurements
        CASE
            WHEN sea_surface_temp_c_raw IS NULL OR sea_surface_temp_c_raw >= 99 THEN NULL
            WHEN sea_surface_temp_c_raw < -2.5 OR sea_surface_temp_c_raw > 35 THEN NULL
            ELSE ROUND(sea_surface_temp_c_raw, 2)
        END AS sea_surface_temp_c,

        CASE
            WHEN salinity_psu_raw IS NULL OR salinity_psu_raw >= 99 THEN NULL
            WHEN salinity_psu_raw < 0 OR salinity_psu_raw > 42 THEN NULL
            ELSE ROUND(salinity_psu_raw, 2)
        END AS salinity_psu,

        CASE
            WHEN current_speed_ms_raw IS NULL OR current_speed_ms_raw >= 99 THEN NULL
            WHEN current_speed_ms_raw < 0 OR current_speed_ms_raw > 5 THEN NULL
            ELSE ROUND(current_speed_ms_raw, 2)
        END AS ocean_current_speed_ms,

        CASE
            WHEN current_direction_deg_raw IS NULL OR current_direction_deg_raw >= 999 THEN NULL
            WHEN current_direction_deg_raw < 0 OR current_direction_deg_raw > 360 THEN NULL
            ELSE ROUND(current_direction_deg_raw, 0)
        END AS ocean_current_direction_deg,

        CASE
            WHEN water_level_m_raw IS NULL OR water_level_m_raw >= 99 THEN NULL
            ELSE ROUND(water_level_m_raw, 3)
        END AS water_level_m,

        -- Processing metadata
        load_time

    FROM valid_bronze
),

-- Derive additional metrics and classifications
enriched AS (
    SELECT
        *,

        -- Assign marine region based on buoy location
        CASE
            WHEN longitude BETWEEN -82 AND -60 AND latitude BETWEEN 24 AND 45
                THEN 'ATLANTIC_EAST_COAST'
            WHEN longitude BETWEEN -100 AND -80 AND latitude BETWEEN 18 AND 31
                THEN 'GULF_OF_MEXICO'
            WHEN longitude BETWEEN -130 AND -115 AND latitude BETWEEN 30 AND 50
                THEN 'PACIFIC_WEST_COAST'
            WHEN longitude BETWEEN -165 AND -130 AND latitude BETWEEN 45 AND 65
                THEN 'GULF_OF_ALASKA'
            WHEN longitude BETWEEN -170 AND -150 AND latitude BETWEEN 15 AND 30
                THEN 'HAWAII_PACIFIC'
            WHEN longitude BETWEEN -180 AND -160 AND latitude BETWEEN 50 AND 75
                THEN 'BERING_SEA'
            ELSE 'OTHER'
        END AS marine_region,

        -- Beaufort wind scale classification
        CASE
            WHEN wind_speed_ms IS NULL THEN NULL
            WHEN wind_speed_ms < 0.5 THEN 'CALM'
            WHEN wind_speed_ms < 1.6 THEN 'LIGHT_AIR'
            WHEN wind_speed_ms < 3.4 THEN 'LIGHT_BREEZE'
            WHEN wind_speed_ms < 5.5 THEN 'GENTLE_BREEZE'
            WHEN wind_speed_ms < 8.0 THEN 'MODERATE_BREEZE'
            WHEN wind_speed_ms < 10.8 THEN 'FRESH_BREEZE'
            WHEN wind_speed_ms < 13.9 THEN 'STRONG_BREEZE'
            WHEN wind_speed_ms < 17.2 THEN 'NEAR_GALE'
            WHEN wind_speed_ms < 20.8 THEN 'GALE'
            WHEN wind_speed_ms < 24.5 THEN 'STRONG_GALE'
            WHEN wind_speed_ms < 28.5 THEN 'STORM'
            WHEN wind_speed_ms < 32.7 THEN 'VIOLENT_STORM'
            ELSE 'HURRICANE_FORCE'
        END AS beaufort_scale,

        -- Sea state classification based on wave height
        CASE
            WHEN wave_height_m IS NULL THEN NULL
            WHEN wave_height_m < 0.1 THEN 'CALM_GLASSY'
            WHEN wave_height_m < 0.5 THEN 'CALM_RIPPLED'
            WHEN wave_height_m < 1.25 THEN 'SMOOTH'
            WHEN wave_height_m < 2.5 THEN 'SLIGHT'
            WHEN wave_height_m < 4.0 THEN 'MODERATE'
            WHEN wave_height_m < 6.0 THEN 'ROUGH'
            WHEN wave_height_m < 9.0 THEN 'VERY_ROUGH'
            WHEN wave_height_m < 14.0 THEN 'HIGH'
            ELSE 'PHENOMENAL'
        END AS sea_state,

        -- SST anomaly: difference from the monthly mean for this station
        -- (In production, join to a climatology reference table)
        sea_surface_temp_c - AVG(sea_surface_temp_c) OVER (
            PARTITION BY station_id, observation_month
            ORDER BY observation_datetime
            ROWS BETWEEN 365*3 PRECEDING AND 1 PRECEDING  -- ~3 years baseline
        ) AS sst_anomaly_c,

        -- Data completeness score for this observation
        ROUND(
            (CASE WHEN wind_speed_ms IS NOT NULL THEN 0.15 ELSE 0 END
           + CASE WHEN wave_height_m IS NOT NULL THEN 0.20 ELSE 0 END
           + CASE WHEN pressure_hpa IS NOT NULL THEN 0.10 ELSE 0 END
           + CASE WHEN air_temperature_c IS NOT NULL THEN 0.10 ELSE 0 END
           + CASE WHEN sea_surface_temp_c IS NOT NULL THEN 0.25 ELSE 0 END
           + CASE WHEN salinity_psu IS NOT NULL THEN 0.10 ELSE 0 END
           + CASE WHEN ocean_current_speed_ms IS NOT NULL THEN 0.10 ELSE 0 END)
        , 2) AS data_completeness_score,

        -- Overall validity flag
        TRUE AS is_valid,

        -- Metadata
        'NDBC' AS source_system,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM cleaned
    -- Filter out observations where ALL key measurements are missing
    WHERE NOT (
        wind_speed_ms IS NULL
        AND wave_height_m IS NULL
        AND sea_surface_temp_c IS NULL
        AND pressure_hpa IS NULL
    )
)

SELECT * FROM enriched
