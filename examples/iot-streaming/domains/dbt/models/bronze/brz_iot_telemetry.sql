{{ config(
    materialized='incremental',
    unique_key=['record_hash'],
    tags=['bronze', 'iot', 'telemetry'],
    on_schema_change='append_new_columns'
) }}

{#
    Bronze layer: raw IoT sensor telemetry.

    Sourced from Event Hub Capture Parquet files (or seed fixtures produced
    by data/generators/generate_telemetry.py). Each row is a single
    metric reading for a single device at a single point in time.

    Fields come from the ADX schema in kql/tables.kql (SensorTelemetry),
    unpivoted into a long (device_id, metric_type, value) shape so we can
    store heterogeneous sensor readings in one Delta table.

    No validation is applied here beyond required-field presence; bad
    readings survive to bronze so they can be audited. The silver layer
    applies range checks, dedup, and anomaly flagging.
#}

WITH source_data AS (
    SELECT
        -- Identity
        COALESCE(device_id, 'UNKNOWN') AS device_id,
        CAST(event_time AS TIMESTAMP) AS event_time,
        UPPER(TRIM(COALESCE(source_event_hub, 'telemetry'))) AS source_event_hub,

        -- Metric identification
        LOWER(TRIM(metric_type)) AS metric_type,
        CAST(value AS DOUBLE) AS value,

        -- Quality
        UPPER(TRIM(COALESCE(quality_flag, 'GOOD'))) AS quality_flag,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS ingestion_ts,
        'EVENT_HUB_CAPTURE' AS source_system,

        -- Dedup key
        MD5(CONCAT_WS('|',
            COALESCE(device_id, ''),
            COALESCE(CAST(event_time AS STRING), ''),
            COALESCE(LOWER(metric_type), ''),
            COALESCE(CAST(value AS STRING), '')
        )) AS record_hash

    FROM {{ source('iot', 'telemetry_capture') }}

    {% if is_incremental() %}
        WHERE event_time > (SELECT COALESCE(MAX(event_time), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE device_id IS NOT NULL
  AND device_id <> 'UNKNOWN'
  AND event_time IS NOT NULL
  AND metric_type IS NOT NULL
