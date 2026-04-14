{{ config(
    materialized='incremental',
    unique_key='crash_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'crash_data', 'cleaned']
) }}

/*
    Silver Layer: Crash Data (Cleansed & Conformed)
    Description: Cleaned FARS crash data with standardized enums for weather,
                 light condition, and road surface. Includes derived severity
                 score, validated geographic coordinates, and temporal buckets.

    Transformations:
      - FARS coded values decoded to human-readable enums
      - Null handling with domain-appropriate defaults
      - Geographic coordinate validation (within US boundaries)
      - Derived severity_score composite metric
      - Time-of-day bucketing for pattern analysis
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_crash_data') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

decoded AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|', case_id, CAST(state_code AS STRING), CAST(crash_year AS STRING))) AS crash_sk,

        -- Identifiers
        case_id,
        state_code,
        state_fips,
        county_code,
        city_code,

        -- Temporal (standardized)
        crash_year,
        crash_month,
        crash_day,
        crash_date,
        day_of_week,
        crash_hour,
        crash_minute,

        -- Day-of-week label
        CASE day_of_week
            WHEN 1 THEN 'SUNDAY'
            WHEN 2 THEN 'MONDAY'
            WHEN 3 THEN 'TUESDAY'
            WHEN 4 THEN 'WEDNESDAY'
            WHEN 5 THEN 'THURSDAY'
            WHEN 6 THEN 'FRIDAY'
            WHEN 7 THEN 'SATURDAY'
            ELSE 'UNKNOWN'
        END AS day_of_week_name,

        -- Time-of-day bucketing for pattern analysis
        CASE
            WHEN crash_hour BETWEEN 6 AND 9 THEN 'MORNING_RUSH'
            WHEN crash_hour BETWEEN 10 AND 15 THEN 'MIDDAY'
            WHEN crash_hour BETWEEN 16 AND 19 THEN 'EVENING_RUSH'
            WHEN crash_hour BETWEEN 20 AND 23 THEN 'EVENING'
            WHEN crash_hour BETWEEN 0 AND 5 THEN 'OVERNIGHT'
            ELSE 'UNKNOWN'
        END AS time_of_day_bucket,

        -- Crash severity counts
        fatality_count,
        drunk_driver_count,
        total_persons,
        total_vehicles,
        pedestrians_involved,

        -- Weather condition decoded from FARS coding manual
        weather_condition_code,
        CASE weather_condition_code
            WHEN 1 THEN 'CLEAR'
            WHEN 2 THEN 'RAIN'
            WHEN 3 THEN 'SLEET_HAIL'
            WHEN 4 THEN 'SNOW'
            WHEN 5 THEN 'FOG_SMOKE'
            WHEN 6 THEN 'CROSSWINDS'
            WHEN 7 THEN 'BLOWING_SAND'
            WHEN 8 THEN 'OTHER'
            WHEN 10 THEN 'CLOUDY'
            WHEN 11 THEN 'BLOWING_SNOW'
            WHEN 12 THEN 'FREEZING_RAIN'
            WHEN 98 THEN 'NOT_REPORTED'
            WHEN 99 THEN 'UNKNOWN'
            ELSE 'UNKNOWN'
        END AS weather_category,

        -- Light condition decoded
        light_condition_code,
        CASE light_condition_code
            WHEN 1 THEN 'DAYLIGHT'
            WHEN 2 THEN 'DARK_NOT_LIGHTED'
            WHEN 3 THEN 'DARK_LIGHTED'
            WHEN 4 THEN 'DAWN'
            WHEN 5 THEN 'DUSK'
            WHEN 6 THEN 'DARK_UNKNOWN_LIGHTING'
            WHEN 7 THEN 'OTHER'
            WHEN 8 THEN 'NOT_REPORTED'
            WHEN 9 THEN 'UNKNOWN'
            ELSE 'UNKNOWN'
        END AS light_category,

        -- Manner of collision decoded
        manner_of_collision_code,
        CASE manner_of_collision_code
            WHEN 0 THEN 'NOT_COLLISION_WITH_VEHICLE'
            WHEN 1 THEN 'FRONT_TO_REAR'
            WHEN 2 THEN 'FRONT_TO_FRONT'
            WHEN 6 THEN 'ANGLE'
            WHEN 7 THEN 'SIDESWIPE_SAME_DIRECTION'
            WHEN 8 THEN 'SIDESWIPE_OPPOSITE_DIRECTION'
            WHEN 9 THEN 'REAR_TO_SIDE'
            WHEN 10 THEN 'REAR_TO_REAR'
            WHEN 98 THEN 'NOT_REPORTED'
            WHEN 99 THEN 'UNKNOWN'
            ELSE 'OTHER'
        END AS manner_of_collision,

        -- Rural/Urban classification
        CASE rural_urban_code
            WHEN 1 THEN 'RURAL'
            WHEN 2 THEN 'URBAN'
            ELSE 'UNKNOWN'
        END AS rural_urban,

        -- Road characteristics
        functional_system,
        CASE functional_system
            WHEN 1 THEN 'INTERSTATE'
            WHEN 2 THEN 'PRINCIPAL_ARTERIAL_FREEWAYS'
            WHEN 3 THEN 'PRINCIPAL_ARTERIAL_OTHER'
            WHEN 4 THEN 'MINOR_ARTERIAL'
            WHEN 5 THEN 'MAJOR_COLLECTOR'
            WHEN 6 THEN 'MINOR_COLLECTOR'
            WHEN 7 THEN 'LOCAL'
            ELSE 'UNKNOWN'
        END AS road_function_class,

        posted_speed_limit,
        on_nhs,
        school_bus_related,

        -- Geographic validation and normalization
        CASE
            WHEN latitude IS NOT NULL
                 AND latitude BETWEEN 18.0 AND 72.0
                 AND longitude IS NOT NULL
                 AND longitude BETWEEN -180.0 AND -60.0
            THEN latitude
            ELSE NULL
        END AS latitude,

        CASE
            WHEN latitude IS NOT NULL
                 AND latitude BETWEEN 18.0 AND 72.0
                 AND longitude IS NOT NULL
                 AND longitude BETWEEN -180.0 AND -60.0
            THEN longitude
            ELSE NULL
        END AS longitude,

        CASE
            WHEN latitude IS NOT NULL
                 AND latitude BETWEEN 18.0 AND 72.0
                 AND longitude IS NOT NULL
                 AND longitude BETWEEN -180.0 AND -60.0
            THEN TRUE
            ELSE FALSE
        END AS has_valid_coordinates,

        -- Derived severity score
        -- Weighted composite: fatalities (10x), drunk drivers (5x bonus),
        -- pedestrians (3x), total vehicles (1x)
        ROUND(
            (COALESCE(fatality_count, 0) * {{ var('crash_severity_weights')['fatality'] }})
            + (CASE WHEN drunk_driver_count > 0 THEN 5 ELSE 0 END)
            + (COALESCE(pedestrians_involved, 0) * 3)
            + (LEAST(COALESCE(total_vehicles, 1), 10))
        , 2) AS severity_score,

        -- Contributing factor flags
        CASE WHEN drunk_driver_count > 0 THEN TRUE ELSE FALSE END AS is_alcohol_related,
        CASE WHEN pedestrians_involved > 0 THEN TRUE ELSE FALSE END AS is_pedestrian_involved,
        CASE WHEN crash_hour BETWEEN 0 AND 5 OR crash_hour BETWEEN 20 AND 23 THEN TRUE ELSE FALSE END AS is_nighttime,

        -- Metadata
        source_system,
        ingestion_timestamp,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
),

-- Add analytical window functions
enriched AS (
    SELECT
        d.*,

        -- Grid cell assignment for hotspot analysis
        CASE
            WHEN has_valid_coordinates
            THEN CONCAT(
                CAST(FLOOR(latitude / {{ var('grid_cell_size') }}) * {{ var('grid_cell_size') }} AS STRING),
                '_',
                CAST(FLOOR(longitude / {{ var('grid_cell_size') }}) * {{ var('grid_cell_size') }} AS STRING)
            )
            ELSE NULL
        END AS grid_cell_id,

        -- State-level crash rate context (rolling window)
        COUNT(*) OVER (
            PARTITION BY state_code, crash_year
        ) AS state_annual_crash_count

    FROM decoded d
)

SELECT * FROM enriched
