{{ config(
    materialized='incremental',
    unique_key=['site_id', 'parameter_code', 'date_local'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'aqs', 'air_quality'],
    on_schema_change='fail'
) }}

{#
    Bronze layer: Raw AQI monitor readings from AQS/AirNow.

    Ingests daily air quality observations from EPA's Air Quality System.
    Each record represents one pollutant measurement at a monitoring site
    on a specific date. Includes both preliminary (AirNow) and quality-
    assured (AQS) data, distinguished by the source_system field.

    AQI values in the source range from 0–500 but raw concentration values
    vary by pollutant (µg/m³ for PM, ppm/ppb for gases). AQI categorization
    is recalculated in the Silver layer using the official EPA breakpoint
    tables for consistency.

    Source: https://aqs.epa.gov/aqsweb/documents/data_api.html
#}

WITH source_data AS (
    SELECT
        -- Source identification
        COALESCE(source_system, 'AQS') AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Site identification (AQS format: SS-CCC-NNNN)
        COALESCE(site_id, CONCAT_WS('-',
            LPAD(COALESCE(state_code, '00'), 2, '0'),
            LPAD(COALESCE(county_code, '000'), 3, '0'),
            LPAD(COALESCE(site_number, '0000'), 4, '0')
        )) AS site_id,

        -- Geographic identifiers
        LPAD(COALESCE(CAST(state_code AS STRING), '00'), 2, '0') AS state_code,
        LPAD(COALESCE(CAST(county_code AS STRING), '000'), 3, '0') AS county_code,
        state_name,
        county_name,
        cbsa_name,

        -- Site location
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,
        datum,

        -- Pollutant identification
        CAST(parameter_code AS STRING) AS parameter_code,
        UPPER(TRIM(parameter_name)) AS parameter_name,
        CAST(poc AS INT) AS poc,

        -- Measurement details
        sample_duration,
        pollutant_standard,
        units_of_measure,
        method_code,
        method_name,

        -- Temporal
        CAST(date_local AS DATE) AS date_local,
        YEAR(CAST(date_local AS DATE)) AS observation_year,
        MONTH(CAST(date_local AS DATE)) AS observation_month,

        -- Observation values
        CAST(observation_count AS INT) AS observation_count,
        CAST(observation_percent AS DECIMAL(5,2)) AS observation_percent,
        CAST(arithmetic_mean AS DECIMAL(12,6)) AS arithmetic_mean,
        CAST(first_max_value AS DECIMAL(12,6)) AS first_max_value,
        CAST(first_max_hour AS INT) AS first_max_hour,
        CAST(aqi AS INT) AS aqi,

        -- Data quality flags
        CASE
            WHEN site_id IS NULL AND state_code IS NULL THEN FALSE
            WHEN date_local IS NULL THEN FALSE
            WHEN parameter_code IS NULL OR TRIM(parameter_code) = '' THEN FALSE
            WHEN CAST(date_local AS DATE) > CURRENT_DATE() THEN FALSE
            WHEN aqi IS NOT NULL AND (CAST(aqi AS INT) < 0 OR CAST(aqi AS INT) > 500) THEN FALSE
            WHEN arithmetic_mean IS NOT NULL AND CAST(arithmetic_mean AS DECIMAL(12,6)) < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN site_id IS NULL AND state_code IS NULL THEN 'Missing site identifier'
            WHEN date_local IS NULL THEN 'Missing observation date'
            WHEN parameter_code IS NULL OR TRIM(parameter_code) = '' THEN 'Missing parameter code'
            WHEN CAST(date_local AS DATE) > CURRENT_DATE() THEN 'Future observation date'
            WHEN aqi IS NOT NULL AND (CAST(aqi AS INT) < 0 OR CAST(aqi AS INT) > 500) THEN 'AQI out of range (0-500)'
            WHEN arithmetic_mean IS NOT NULL AND CAST(arithmetic_mean AS DECIMAL(12,6)) < 0 THEN 'Negative concentration'
            ELSE NULL
        END AS validation_errors,

        -- Processing metadata
        load_time,
        MD5(CONCAT_WS('|',
            COALESCE(site_id, ''),
            COALESCE(CAST(parameter_code AS STRING), ''),
            COALESCE(CAST(date_local AS STRING), ''),
            COALESCE(CAST(poc AS STRING), '')
        )) AS record_hash,

        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('epa', 'aqs_air_quality') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND (site_id IS NOT NULL OR state_code IS NOT NULL)
    AND date_local IS NOT NULL
    AND parameter_code IS NOT NULL
