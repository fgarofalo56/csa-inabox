{{ config(
    materialized='incremental',
    unique_key=['station_id', 'observation_date', 'element'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'ghcn', 'weather_stations']
) }}

{#
    Bronze layer: Raw GHCN-Daily weather station observations.

    Ingests daily weather observations from the Global Historical Climatology
    Network. Each record represents a single element measurement (TMAX, TMIN,
    PRCP, etc.) at a specific station on a specific date. Values are stored in
    their original GHCN units (tenths of degrees Celsius, tenths of mm) and
    are converted to standard units in the Silver layer.

    GHCN quality flags are preserved verbatim for downstream QC processing.

    Source: https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'GHCN_DAILY' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Station identification
        COALESCE(station_id, 'UNKNOWN') AS station_id,
        station_name,
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,
        CAST(elevation AS DECIMAL(7,2)) AS elevation_m,

        -- Geographic context
        state_code,
        country_code,

        -- Time dimension
        CAST(observation_date AS DATE) AS observation_date,
        YEAR(CAST(observation_date AS DATE)) AS observation_year,
        MONTH(CAST(observation_date AS DATE)) AS observation_month,

        -- Observation data (kept in raw GHCN units)
        UPPER(TRIM(element)) AS element,
        CAST(REPLACE(REPLACE(COALESCE(value, ''), ',', ''), ' ', '') AS STRING) AS value_raw,

        -- GHCN quality flags (preserved as-is)
        measurement_flag,
        quality_flag,
        source_flag,

        -- Data quality validation
        CASE
            WHEN station_id IS NULL OR TRIM(station_id) = '' THEN FALSE
            WHEN observation_date IS NULL THEN FALSE
            WHEN element IS NULL OR TRIM(element) = '' THEN FALSE
            WHEN value IS NULL OR TRIM(value) = '' THEN FALSE
            -- GHCN quality flag 'D' = failed duplicate check, etc.
            WHEN quality_flag IN ('D', 'I', 'K', 'L', 'N', 'O', 'R', 'S', 'T', 'W', 'X') THEN FALSE
            WHEN CAST(observation_date AS DATE) > CURRENT_DATE() THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN station_id IS NULL OR TRIM(station_id) = '' THEN 'Missing station ID'
            WHEN observation_date IS NULL THEN 'Missing observation date'
            WHEN element IS NULL OR TRIM(element) = '' THEN 'Missing element type'
            WHEN value IS NULL OR TRIM(value) = '' THEN 'Missing value'
            WHEN quality_flag IN ('D', 'I', 'K', 'L', 'N', 'O', 'R', 'S', 'T', 'W', 'X')
                THEN CONCAT('Failed GHCN QC: flag=', quality_flag)
            WHEN CAST(observation_date AS DATE) > CURRENT_DATE() THEN 'Future observation date'
            ELSE NULL
        END AS validation_errors,

        -- Processing metadata
        load_time,
        MD5(CONCAT_WS('|',
            COALESCE(station_id, ''),
            COALESCE(CAST(observation_date AS STRING), ''),
            COALESCE(element, ''),
            COALESCE(CAST(value AS STRING), '')
        )) AS record_hash,

        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('noaa', 'ghcn_daily') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    -- Basic presence filters (keep invalid records for auditing, but
    -- require minimum identifiers for meaningful storage)
    AND station_id IS NOT NULL
    AND observation_date IS NOT NULL
    AND element IS NOT NULL
