{{ config(
    materialized='incremental',
    unique_key=['record_hash'],
    tags=['bronze', 'iot', 'slots'],
    on_schema_change='append_new_columns'
) }}

{#
    Bronze layer: casino slot-machine telemetry events arriving via the
    streaming pipeline. Columns mirror the ADX SlotEvents table in
    kql/tables.kql. Ties into the casino-analytics vertical.
#}

WITH source_data AS (
    SELECT
        COALESCE(machine_id, 'UNKNOWN') AS machine_id,
        CAST(event_time AS TIMESTAMP) AS event_time,
        UPPER(TRIM(event_type)) AS event_type,

        CAST(denomination AS DECIMAL(8,2)) AS denomination,
        CAST(credits_wagered AS INT) AS credits_wagered,
        CAST(credits_won AS INT) AS credits_won,
        CAST(coin_in AS DECIMAL(12,2)) AS coin_in,
        CAST(coin_out AS DECIMAL(12,2)) AS coin_out,

        UPPER(TRIM(floor_zone)) AS floor_zone,
        UPPER(TRIM(game_theme)) AS game_theme,

        UPPER(TRIM(COALESCE(quality_flag, 'GOOD'))) AS quality_flag,

        CURRENT_TIMESTAMP() AS ingestion_ts,
        'EVENT_HUB_CAPTURE' AS source_system,

        MD5(CONCAT_WS('|',
            COALESCE(machine_id, ''),
            COALESCE(CAST(event_time AS STRING), ''),
            COALESCE(event_type, ''),
            COALESCE(CAST(coin_in AS STRING), ''),
            COALESCE(CAST(coin_out AS STRING), '')
        )) AS record_hash

    FROM {{ source('iot', 'slots_capture') }}

    {% if is_incremental() %}
        WHERE event_time > (SELECT COALESCE(MAX(event_time), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE machine_id IS NOT NULL
  AND machine_id <> 'UNKNOWN'
  AND event_time IS NOT NULL
