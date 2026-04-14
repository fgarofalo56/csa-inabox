{{ config(
    materialized='incremental',
    unique_key=['park_code', 'year', 'month'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'nps', 'visitors', 'parks']
) }}

{#
    Bronze Layer: NPS Visitor Statistics

    Source: National Park Service Integrated Resource Management Applications (IRMA)
    API: https://irma.nps.gov/Stats/
    Coverage: All 423+ NPS units (national parks, monuments, seashores, etc.)

    The NPS visitor statistics program has tracked recreation visits since 1904.
    Data is reported monthly by individual park units. Visit counts represent
    "recreation visits" — a person entering an area for recreational purposes.

    Key considerations:
    - Monthly data has a ~90-day reporting lag
    - Some parks count vehicle entries (multiplied by occupancy factor)
    - Backcountry visits are estimated from permit data
    - COVID-19 caused significant disruptions in 2020-2021
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'NPS_STATS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Park identification
        UPPER(TRIM(park_code)) AS park_code,
        INITCAP(TRIM(park_name)) AS park_name,
        park_type,   -- 'National Park', 'National Monument', 'National Seashore', etc.
        state,       -- State abbreviation(s), may be multiple (e.g., 'CA,NV')
        region,      -- NPS region

        -- Time dimension
        CAST(year AS INT) AS year,
        CAST(month AS INT) AS month,

        -- Visitor counts
        CAST(recreation_visits AS BIGINT) AS recreation_visits,
        CAST(non_recreation_visits AS BIGINT) AS non_recreation_visits,
        CAST(recreation_hours AS DECIMAL(18, 2)) AS recreation_hours,
        CAST(concessioner_lodging AS BIGINT) AS concessioner_lodging,
        CAST(concessioner_camping AS BIGINT) AS concessioner_camping,
        CAST(tent_campers AS BIGINT) AS tent_campers,
        CAST(rv_campers AS BIGINT) AS rv_campers,
        CAST(backcountry_campers AS BIGINT) AS backcountry_campers,

        -- Park characteristics (may come from a dimension table join)
        CAST(park_acres AS DECIMAL(14, 2)) AS park_acres,
        CAST(trail_miles AS DECIMAL(8, 2)) AS trail_miles,
        CAST(campground_capacity AS INT) AS campground_capacity,
        CAST(parking_spaces AS INT) AS parking_spaces,

        -- Data quality flags
        CASE
            WHEN park_code IS NULL OR LENGTH(park_code) < 2 THEN FALSE
            WHEN year IS NULL OR year < 1900 OR year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN month IS NULL OR month < 1 OR month > 12 THEN FALSE
            WHEN recreation_visits IS NULL THEN FALSE
            WHEN recreation_visits < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN park_code IS NULL OR LENGTH(park_code) < 2 THEN 'Invalid park code'
            WHEN year IS NULL OR year < 1900 THEN 'Invalid year'
            WHEN month IS NULL OR month < 1 OR month > 12 THEN 'Invalid month'
            WHEN recreation_visits IS NULL THEN 'Missing visitor count'
            WHEN recreation_visits < 0 THEN 'Negative visitor count'
            ELSE NULL
        END AS validation_errors,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Record hash
        MD5(CONCAT_WS('|',
            COALESCE(park_code, ''),
            COALESCE(CAST(year AS STRING), ''),
            COALESCE(CAST(month AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('interior', 'nps_visitors') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND park_code IS NOT NULL
    AND year IS NOT NULL
    AND month IS NOT NULL
