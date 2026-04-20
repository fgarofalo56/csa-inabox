{{ config(
    materialized='incremental',
    unique_key=['record_hash'],
    tags=['bronze', 'iot', 'aqi'],
    on_schema_change='append_new_columns'
) }}

{#
    Bronze layer: EPA-style AQI monitor readings arriving via the streaming
    pipeline. Columns mirror the ADX AQIReadings table in kql/tables.kql.
#}

WITH source_data AS (
    SELECT
        COALESCE(sensor_id, 'UNKNOWN') AS sensor_id,
        CAST(event_time AS TIMESTAMP) AS event_time,

        CAST(pm25_ugm3 AS DOUBLE) AS pm25_ugm3,
        CAST(pm10_ugm3 AS DOUBLE) AS pm10_ugm3,
        CAST(ozone_ppb AS DOUBLE) AS ozone_ppb,
        CAST(no2_ppb AS DOUBLE) AS no2_ppb,
        CAST(aqi AS INT) AS aqi,
        UPPER(TRIM(aqi_category)) AS aqi_category,
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,

        UPPER(TRIM(COALESCE(quality_flag, 'GOOD'))) AS quality_flag,

        CURRENT_TIMESTAMP() AS ingestion_ts,
        'EVENT_HUB_CAPTURE' AS source_system,

        MD5(CONCAT_WS('|',
            COALESCE(sensor_id, ''),
            COALESCE(CAST(event_time AS STRING), ''),
            COALESCE(CAST(pm25_ugm3 AS STRING), ''),
            COALESCE(CAST(aqi AS STRING), '')
        )) AS record_hash

    FROM {{ source('iot', 'aqi_capture') }}

    {% if is_incremental() %}
        WHERE event_time > (SELECT COALESCE(MAX(event_time), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE sensor_id IS NOT NULL
  AND sensor_id <> 'UNKNOWN'
  AND event_time IS NOT NULL
