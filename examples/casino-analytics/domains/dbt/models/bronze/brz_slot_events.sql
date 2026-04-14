{{ config(
    materialized='incremental',
    unique_key=['event_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'slot', 'telemetry', 'streaming']
) }}

/*
    Bronze Layer — Raw Slot Machine Telemetry

    Source: Slot Management System (SMS) via Event Hub → Stream Analytics → ADLS.
    Captures individual spin events, jackpots, bonus rounds, and error conditions
    from SAS-protocol-connected slot machines.

    High-volume table: ~50M events/day in production.
    All data is ENTIRELY SYNTHETIC. No real slot machine data.
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'SLOT_MGMT_SYSTEM' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Event identifiers
        CAST(event_id AS STRING) AS event_id,
        CAST(machine_id AS STRING) AS machine_id,

        -- Event timing
        CAST(event_timestamp AS TIMESTAMP) AS event_timestamp,

        -- Event classification
        UPPER(TRIM(event_type)) AS event_type,

        -- Machine configuration
        CAST(denomination AS DECIMAL(6,2)) AS denomination,

        -- Wager and payout
        CAST(credits_wagered AS INT) AS credits_wagered,
        CAST(credits_won AS INT) AS credits_won,

        -- RTP (Return to Player) tracking
        CAST(rtp_contribution AS DECIMAL(8,4)) AS rtp_contribution,

        -- Location
        UPPER(TRIM(floor_zone)) AS floor_zone,

        -- Player linkage (may be NULL for unrated play)
        CAST(player_id AS STRING) AS player_id,
        CAST(session_id AS STRING) AS session_id,

        -- Data quality flags
        CASE
            WHEN event_id IS NULL THEN FALSE
            WHEN machine_id IS NULL THEN FALSE
            WHEN event_timestamp IS NULL THEN FALSE
            WHEN event_type IS NULL THEN FALSE
            WHEN event_type NOT IN ('SPIN', 'JACKPOT', 'BONUS', 'ERROR', 'CASH_IN', 'CASH_OUT', 'TILT') THEN FALSE
            WHEN denomination IS NULL OR denomination <= 0 THEN FALSE
            WHEN credits_wagered IS NOT NULL AND credits_wagered < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN event_id IS NULL THEN 'Missing event_id'
            WHEN machine_id IS NULL THEN 'Missing machine_id'
            WHEN event_timestamp IS NULL THEN 'Missing event_timestamp'
            WHEN event_type IS NULL THEN 'Missing event_type'
            WHEN event_type NOT IN ('SPIN', 'JACKPOT', 'BONUS', 'ERROR', 'CASH_IN', 'CASH_OUT', 'TILT') THEN 'Invalid event_type'
            WHEN denomination IS NULL OR denomination <= 0 THEN 'Invalid denomination'
            WHEN credits_wagered IS NOT NULL AND credits_wagered < 0 THEN 'Negative credits_wagered'
            ELSE NULL
        END AS validation_errors,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(event_id AS STRING), ''),
            COALESCE(CAST(machine_id AS STRING), ''),
            COALESCE(CAST(event_timestamp AS STRING), '')
        )) AS record_hash,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('casino', 'slot_events') }}

    {% if is_incremental() %}
        WHERE event_timestamp > (SELECT MAX(event_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE event_id IS NOT NULL
  AND machine_id IS NOT NULL
