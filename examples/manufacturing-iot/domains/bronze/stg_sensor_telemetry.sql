-- ==========================================================================
-- Staging Model: Raw Sensor Telemetry
-- Source: Bronze layer - raw sensor readings from IoT Hub / Event Hubs
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='reading_id',
    schema='bronze'
) }}

SELECT
    reading_id                                      AS reading_id,
    device_id                                       AS device_id,
    equipment_id                                    AS equipment_id,
    CAST(sensor_type AS STRING)                     AS sensor_type,
    CAST(reading_value AS DOUBLE)                   AS reading_value,
    CAST(unit AS STRING)                            AS unit,
    CAST(reading_timestamp AS TIMESTAMP)            AS reading_timestamp,
    CAST(quality_flag AS STRING)                    AS quality_flag,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('iot_raw', 'raw_sensor_telemetry') }}

{% if is_incremental() %}
WHERE CAST(reading_timestamp AS TIMESTAMP) > (
    SELECT MAX(reading_timestamp) FROM {{ this }}
)
{% endif %}
