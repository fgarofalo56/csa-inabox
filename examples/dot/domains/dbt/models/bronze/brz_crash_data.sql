{{ config(
    materialized='incremental',
    unique_key=['case_id', 'state_code'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'fars', 'crash_data']
) }}

/*
    Bronze Layer: FARS Crash Data
    Source: NHTSA Fatality Analysis Reporting System (FARS)
    Description: Raw fatal motor vehicle crash records ingested from the FARS API
                 or flat file downloads. Each record represents a single crash event
                 with location, timing, environmental, and outcome data.

    Grain: One row per crash event (case_id + state_code)
    Update frequency: Annual (FARS final), with preliminary data available monthly
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'NHTSA_FARS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Crash identifiers
        CAST(st_case AS STRING) AS case_id,
        CAST(state AS INT) AS state_code,
        LPAD(CAST(state AS STRING), 2, '0') AS state_fips,

        -- Geographic fields (raw, will be standardized in Silver)
        CAST(county AS INT) AS county_code,
        CAST(city AS INT) AS city_code,
        CAST(latitude AS DECIMAL(10, 6)) AS latitude,
        CAST(longitude AS DECIMAL(10, 6)) AS longitude,
        CAST(route AS INT) AS route_type,
        CAST(tway_id AS STRING) AS trafficway_id,
        CAST(tway_id2 AS STRING) AS trafficway_id2,
        CAST(rur_urb AS INT) AS rural_urban_code,
        CAST(func_sys AS INT) AS functional_system,

        -- Temporal fields
        CAST(year AS INT) AS crash_year,
        CAST(month AS INT) AS crash_month,
        CAST(day AS INT) AS crash_day,
        CAST(day_week AS INT) AS day_of_week,
        CAST(hour AS INT) AS crash_hour,
        CAST(minute AS INT) AS crash_minute,

        -- Attempt to build a proper crash_date
        CASE
            WHEN year IS NOT NULL AND month BETWEEN 1 AND 12 AND day BETWEEN 1 AND 31
            THEN TRY_CAST(CONCAT(year, '-', LPAD(month, 2, '0'), '-', LPAD(day, 2, '0')) AS DATE)
            ELSE NULL
        END AS crash_date,

        -- Crash characteristics
        CAST(fatals AS INT) AS fatality_count,
        CAST(drunk_dr AS INT) AS drunk_driver_count,
        CAST(persons AS INT) AS total_persons,
        CAST(ve_total AS INT) AS total_vehicles,
        CAST(ve_forms AS INT) AS vehicles_in_transport,
        CAST(peds AS INT) AS pedestrians_involved,
        CAST(nhs AS INT) AS on_nhs,
        CAST(sp_jur AS INT) AS special_jurisdiction,

        -- Environmental conditions (raw coded values)
        CAST(weather AS INT) AS weather_condition_code,
        CAST(weather1 AS INT) AS weather_condition_code_1,
        CAST(weather2 AS INT) AS weather_condition_code_2,
        CAST(lgt_cond AS INT) AS light_condition_code,
        CAST(cf1 AS INT) AS contributing_factor_1,
        CAST(cf2 AS INT) AS contributing_factor_2,
        CAST(cf3 AS INT) AS contributing_factor_3,

        -- Road characteristics
        CAST(rd_owner AS INT) AS road_owner,
        CAST(man_coll AS INT) AS manner_of_collision_code,
        CAST(typ_int AS INT) AS intersection_type_code,
        CAST(rel_road AS INT) AS relation_to_road_code,
        CAST(sch_bus AS INT) AS school_bus_related,

        -- Speed and DUI indicators
        CAST(sp_limit AS INT) AS posted_speed_limit,

        -- Data quality flags for Bronze layer
        CASE
            WHEN st_case IS NULL THEN FALSE
            WHEN state IS NULL THEN FALSE
            WHEN year IS NULL OR year < 1975 OR year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN fatals IS NULL OR fatals < 0 THEN FALSE
            WHEN latitude IS NOT NULL AND (latitude < 18.0 OR latitude > 72.0) THEN FALSE
            WHEN longitude IS NOT NULL AND (longitude < -180.0 OR longitude > -60.0) THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN st_case IS NULL THEN 'Missing case ID'
            WHEN state IS NULL THEN 'Missing state code'
            WHEN year IS NULL OR year < 1975 THEN 'Invalid year'
            WHEN fatals IS NULL OR fatals < 0 THEN 'Invalid fatality count'
            WHEN latitude IS NOT NULL AND (latitude < 18.0 OR latitude > 72.0) THEN 'Latitude out of US range'
            WHEN longitude IS NOT NULL AND (longitude < -180.0 OR longitude > -60.0) THEN 'Longitude out of US range'
            ELSE NULL
        END AS validation_errors,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(st_case AS STRING), ''),
            COALESCE(CAST(state AS STRING), ''),
            COALESCE(CAST(year AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('dot', 'fars_crash_data') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    -- Minimum required fields for a valid crash record
    AND case_id IS NOT NULL
    AND state_code IS NOT NULL
    AND crash_year IS NOT NULL
