{{ config(
    materialized='incremental',
    unique_key=['event_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'ncei', 'storm_events'],
    on_schema_change='fail'
) }}

{#
    Bronze layer: Raw NCEI Storm Events Database records.

    Ingests severe weather event records from the NOAA/NCEI Storm Events
    Database. Each record documents a significant weather event including
    tornadoes, thunderstorm wind, hail, floods, winter storms, and hurricanes.
    Records include damage estimates, casualties, event narratives, and
    geographic coordinates.

    Damage values are stored as raw strings because the source uses codes
    like "25K" or "1.5M" that require parsing in the Silver layer.

    Source: https://www.ncdc.noaa.gov/stormevents/
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'NCEI_STORM_EVENTS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Event identification
        COALESCE(CAST(event_id AS STRING),
            MD5(CONCAT_WS('|', state, event_type, CAST(begin_date AS STRING)))
        ) AS event_id,
        CAST(episode_id AS STRING) AS episode_id,

        -- Event classification
        UPPER(TRIM(event_type)) AS event_type,

        -- Temporal fields
        CAST(begin_date AS DATE) AS begin_date,
        CAST(end_date AS DATE) AS end_date,
        begin_time,
        end_time,
        YEAR(CAST(begin_date AS DATE)) AS event_year,
        MONTH(CAST(begin_date AS DATE)) AS event_month,

        -- Geographic fields
        UPPER(TRIM(state)) AS state,
        LPAD(COALESCE(CAST(state_fips AS STRING), '00'), 2, '0') AS state_fips,
        UPPER(TRIM(cz_name)) AS county_zone_name,
        cz_type,
        LPAD(COALESCE(CAST(cz_fips AS STRING), '000'), 3, '0') AS county_zone_fips,

        -- Event coordinates
        CAST(begin_lat AS DECIMAL(9,6)) AS begin_lat,
        CAST(begin_lon AS DECIMAL(9,6)) AS begin_lon,
        CAST(end_lat AS DECIMAL(9,6)) AS end_lat,
        CAST(end_lon AS DECIMAL(9,6)) AS end_lon,

        -- Magnitude
        CAST(magnitude AS STRING) AS magnitude_raw,
        magnitude_type,

        -- Casualties
        CAST(COALESCE(injuries_direct, 0) AS INT) AS injuries_direct,
        CAST(COALESCE(injuries_indirect, 0) AS INT) AS injuries_indirect,
        CAST(COALESCE(deaths_direct, 0) AS INT) AS deaths_direct,
        CAST(COALESCE(deaths_indirect, 0) AS INT) AS deaths_indirect,

        -- Damage estimates (raw strings like "25K", "1.5M", "0.00K")
        COALESCE(CAST(damage_property AS STRING), '0') AS damage_property_raw,
        COALESCE(CAST(damage_crops AS STRING), '0') AS damage_crops_raw,

        -- Weather details
        TRIM(source) AS source,
        tor_f_scale,
        tor_length,
        tor_width,
        flood_cause,

        -- Narrative text
        event_narrative,
        episode_narrative,

        -- Data quality flags
        CASE
            WHEN event_type IS NULL OR TRIM(event_type) = '' THEN FALSE
            WHEN begin_date IS NULL THEN FALSE
            WHEN state IS NULL OR TRIM(state) = '' THEN FALSE
            WHEN CAST(begin_date AS DATE) > CURRENT_DATE() THEN FALSE
            WHEN YEAR(CAST(begin_date AS DATE)) < 1950 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN event_type IS NULL OR TRIM(event_type) = '' THEN 'Missing event type'
            WHEN begin_date IS NULL THEN 'Missing begin date'
            WHEN state IS NULL OR TRIM(state) = '' THEN 'Missing state'
            WHEN CAST(begin_date AS DATE) > CURRENT_DATE() THEN 'Future event date'
            WHEN YEAR(CAST(begin_date AS DATE)) < 1950 THEN 'Pre-database event date'
            ELSE NULL
        END AS validation_errors,

        -- Processing metadata
        load_time,
        MD5(CONCAT_WS('|',
            COALESCE(CAST(event_id AS STRING), ''),
            COALESCE(state, ''),
            COALESCE(event_type, ''),
            COALESCE(CAST(begin_date AS STRING), '')
        )) AS record_hash,

        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('noaa', 'storm_events') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND event_type IS NOT NULL
    AND begin_date IS NOT NULL
    AND state IS NOT NULL
