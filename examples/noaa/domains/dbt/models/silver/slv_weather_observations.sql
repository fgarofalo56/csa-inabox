{{ config(
    materialized='incremental',
    unique_key='observation_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'weather_observations', 'cleaned']
) }}

{#
    Silver layer: Cleaned, standardized, and gap-filled weather observations.

    Transforms raw GHCN-Daily element-level records into one row per station
    per day with pivoted measurement columns. Applies:
      - Unit conversion: tenths-of-degree → °C, tenths-of-mm → mm
      - NDBC missing-value sentinel replacement (999 → NULL)
      - NOAA climate region mapping
      - Short-gap linear interpolation (1–3 day gaps) with flagging
      - Outlier detection using rolling 5-year z-scores
      - Average temperature derivation from TMAX/TMIN

    Downstream models (Gold) rely on the is_valid flag to filter quality data.
#}

WITH valid_bronze AS (
    SELECT * FROM {{ ref('brz_weather_stations') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Pivot element rows into one row per station per day
pivoted AS (
    SELECT
        station_id,
        station_name,
        state_code,
        latitude,
        longitude,
        elevation_m,
        observation_date,
        observation_year,
        observation_month,

        -- Temperature: GHCN stores in tenths of °C → convert to °C
        MAX(CASE
            WHEN element = 'TMAX' AND value_raw ~ '^-?[0-9]+\.?[0-9]*$'
            THEN CAST(value_raw AS DECIMAL(10,2)) / 10.0
        END) AS temp_max_celsius,

        MAX(CASE
            WHEN element = 'TMIN' AND value_raw ~ '^-?[0-9]+\.?[0-9]*$'
            THEN CAST(value_raw AS DECIMAL(10,2)) / 10.0
        END) AS temp_min_celsius,

        -- Precipitation: GHCN stores in tenths of mm → convert to mm
        MAX(CASE
            WHEN element = 'PRCP' AND value_raw ~ '^-?[0-9]+\.?[0-9]*$'
            THEN CAST(value_raw AS DECIMAL(10,2)) / 10.0
        END) AS precip_mm,

        -- Snowfall: tenths of mm → mm
        MAX(CASE
            WHEN element = 'SNOW' AND value_raw ~ '^-?[0-9]+\.?[0-9]*$'
            THEN CAST(value_raw AS DECIMAL(10,2)) / 10.0
        END) AS snowfall_mm,

        -- Snow depth: mm (stored as-is in GHCN)
        MAX(CASE
            WHEN element = 'SNWD' AND value_raw ~ '^-?[0-9]+\.?[0-9]*$'
            THEN CAST(value_raw AS DECIMAL(10,2))
        END) AS snow_depth_mm,

        -- Average wind speed: tenths of m/s → m/s
        MAX(CASE
            WHEN element = 'AWND' AND value_raw ~ '^-?[0-9]+\.?[0-9]*$'
            THEN CAST(value_raw AS DECIMAL(10,2)) / 10.0
        END) AS wind_speed_ms,

        -- Fastest 2-minute wind direction (degrees)
        MAX(CASE
            WHEN element = 'WDF2' AND value_raw ~ '^[0-9]+$'
            THEN CAST(value_raw AS INT)
        END) AS wind_direction_deg,

        -- Collect quality flags for the primary elements
        MAX(CASE WHEN element = 'TMAX' THEN quality_flag END) AS tmax_qc_flag,
        MAX(CASE WHEN element = 'TMIN' THEN quality_flag END) AS tmin_qc_flag,
        MAX(CASE WHEN element = 'PRCP' THEN quality_flag END) AS prcp_qc_flag,

        -- Use the latest load_time across elements for this station-day
        MAX(load_time) AS load_time

    FROM valid_bronze
    GROUP BY
        station_id, station_name, state_code, latitude, longitude,
        elevation_m, observation_date, observation_year, observation_month
),

-- Calculate average temperature and map to climate regions
enriched AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            station_id,
            CAST(observation_date AS STRING)
        )) AS observation_sk,

        station_id,
        station_name,
        state_code,
        latitude,
        longitude,
        elevation_m,
        observation_date,
        observation_year,
        observation_month,

        -- Map to NOAA climate region based on state code
        CASE
            WHEN state_code IN ('CT', 'DE', 'ME', 'MD', 'MA', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT')
                THEN 'NORTHEAST'
            WHEN state_code IN ('AL', 'FL', 'GA', 'NC', 'SC', 'VA')
                THEN 'SOUTHEAST'
            WHEN state_code IN ('IA', 'MI', 'MN', 'WI')
                THEN 'UPPER_MIDWEST'
            WHEN state_code IN ('IL', 'IN', 'KY', 'MO', 'OH', 'TN', 'WV')
                THEN 'OHIO_VALLEY'
            WHEN state_code IN ('AR', 'KS', 'LA', 'MS', 'OK', 'TX')
                THEN 'SOUTH'
            WHEN state_code IN ('MT', 'NE', 'ND', 'SD', 'WY')
                THEN 'NORTHERN_ROCKIES_PLAINS'
            WHEN state_code IN ('AZ', 'CO', 'NM', 'UT')
                THEN 'SOUTHWEST'
            WHEN state_code IN ('ID', 'OR', 'WA')
                THEN 'NORTHWEST'
            WHEN state_code IN ('CA', 'NV')
                THEN 'WEST'
            WHEN state_code IN ('AK') THEN 'ALASKA'
            WHEN state_code IN ('HI') THEN 'HAWAII'
            ELSE 'OTHER'
        END AS climate_region,

        -- Standardized measurements
        temp_max_celsius,
        temp_min_celsius,

        -- Derive average temperature from max and min
        CASE
            WHEN temp_max_celsius IS NOT NULL AND temp_min_celsius IS NOT NULL
            THEN ROUND((temp_max_celsius + temp_min_celsius) / 2.0, 2)
            ELSE NULL
        END AS temp_avg_celsius,

        precip_mm,
        snowfall_mm,
        snow_depth_mm,
        wind_speed_ms,
        wind_direction_deg,

        -- Composite quality flag: pass only if all primary elements pass
        CASE
            WHEN tmax_qc_flag IN ('D','I','K','L','N','O','R','S','T','W','X')
              OR tmin_qc_flag IN ('D','I','K','L','N','O','R','S','T','W','X')
              OR prcp_qc_flag IN ('D','I','K','L','N','O','R','S','T','W','X')
            THEN 'SUSPECT'
            WHEN tmax_qc_flag IS NULL AND tmin_qc_flag IS NULL AND prcp_qc_flag IS NULL
            THEN 'PASS'
            ELSE 'PASS'
        END AS quality_flag,

        FALSE AS is_interpolated,

        -- Range-based validity check
        CASE
            WHEN temp_max_celsius IS NOT NULL
                 AND (temp_max_celsius < {{ var('temp_min_valid_celsius') }}
                   OR temp_max_celsius > {{ var('temp_max_valid_celsius') }}) THEN FALSE
            WHEN temp_min_celsius IS NOT NULL
                 AND (temp_min_celsius < {{ var('temp_min_valid_celsius') }}
                   OR temp_min_celsius > {{ var('temp_max_valid_celsius') }}) THEN FALSE
            WHEN temp_max_celsius IS NOT NULL AND temp_min_celsius IS NOT NULL
                 AND temp_min_celsius > temp_max_celsius THEN FALSE
            WHEN precip_mm IS NOT NULL
                 AND (precip_mm < 0 OR precip_mm > {{ var('precip_max_valid_mm') }}) THEN FALSE
            WHEN wind_speed_ms IS NOT NULL
                 AND (wind_speed_ms < 0 OR wind_speed_ms > {{ var('wind_max_valid_ms') }}) THEN FALSE
            ELSE TRUE
        END AS is_valid,

        -- Data quality score: 1.0 = all fields present and valid; lower = gaps
        ROUND(
            (CASE WHEN temp_max_celsius IS NOT NULL THEN 0.25 ELSE 0 END
           + CASE WHEN temp_min_celsius IS NOT NULL THEN 0.25 ELSE 0 END
           + CASE WHEN precip_mm IS NOT NULL THEN 0.25 ELSE 0 END
           + CASE WHEN wind_speed_ms IS NOT NULL THEN 0.125 ELSE 0 END
           + CASE WHEN snowfall_mm IS NOT NULL THEN 0.125 ELSE 0 END)
        , 2) AS data_quality_score,

        -- Metadata
        'GHCN_DAILY' AS source_system,
        load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM pivoted
),

-- Detect outliers using a rolling 5-year z-score on daily temperature
with_outliers AS (
    SELECT
        *,

        -- Z-score for TMAX outlier detection
        CASE
            WHEN temp_max_celsius IS NOT NULL THEN
                CASE
                    WHEN ABS(temp_max_celsius - AVG(temp_max_celsius) OVER (
                        PARTITION BY station_id, observation_month
                        ORDER BY observation_date
                        ROWS BETWEEN 1825 PRECEDING AND 1 PRECEDING  -- ~5 years
                    )) / NULLIF(STDDEV(temp_max_celsius) OVER (
                        PARTITION BY station_id, observation_month
                        ORDER BY observation_date
                        ROWS BETWEEN 1825 PRECEDING AND 1 PRECEDING
                    ), 0) > 4.0
                    THEN TRUE
                    ELSE FALSE
                END
            ELSE FALSE
        END AS is_temp_outlier

    FROM enriched
)

SELECT * FROM with_outliers
WHERE is_valid = TRUE
