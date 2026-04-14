{{ config(
    materialized='incremental',
    unique_key=['session_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'player', 'sessions', 'gaming']
) }}

/*
    Bronze Layer — Raw Player Tracking Sessions

    Source: Player Tracking System (PTS) nightly extract.
    Captures rated play sessions from slot machines and table games
    with coin-in/coin-out, theoretical win, and tier information.

    All data is ENTIRELY SYNTHETIC. No real player data.
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'PLAYER_TRACKING' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Session identifiers
        CAST(session_id AS STRING) AS session_id,
        CAST(player_id AS STRING) AS player_id,

        -- Location: machine for slots, table for table games
        CAST(machine_id AS STRING) AS machine_id,

        -- Session timing
        CAST(session_date AS DATE) AS session_date,
        CAST(session_start AS TIMESTAMP) AS session_start,
        CAST(duration_minutes AS INT) AS duration_minutes,

        -- Game classification
        UPPER(TRIM(game_type)) AS game_type,

        -- Financial metrics
        CAST(coin_in AS DECIMAL(12,2)) AS coin_in,
        CAST(coin_out AS DECIMAL(12,2)) AS coin_out,
        CAST(theoretical_win AS DECIMAL(12,2)) AS theoretical_win,
        CAST(actual_win AS DECIMAL(12,2)) AS actual_win,
        CAST(denomination AS DECIMAL(6,2)) AS denomination,

        -- Player information
        UPPER(TRIM(floor_zone)) AS floor_zone,

        -- Data quality flags
        CASE
            WHEN session_id IS NULL THEN FALSE
            WHEN player_id IS NULL THEN FALSE
            WHEN session_date IS NULL THEN FALSE
            WHEN session_date > CURRENT_DATE() THEN FALSE
            WHEN coin_in IS NULL OR coin_in < 0 THEN FALSE
            WHEN coin_out IS NULL OR coin_out < 0 THEN FALSE
            WHEN duration_minutes IS NOT NULL AND duration_minutes < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN session_id IS NULL THEN 'Missing session_id'
            WHEN player_id IS NULL THEN 'Missing player_id'
            WHEN session_date IS NULL THEN 'Missing session_date'
            WHEN session_date > CURRENT_DATE() THEN 'Future session_date'
            WHEN coin_in IS NULL OR coin_in < 0 THEN 'Invalid coin_in'
            WHEN coin_out IS NULL OR coin_out < 0 THEN 'Invalid coin_out'
            WHEN duration_minutes IS NOT NULL AND duration_minutes < 0 THEN 'Negative duration'
            ELSE NULL
        END AS validation_errors,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(session_id AS STRING), ''),
            COALESCE(CAST(player_id AS STRING), ''),
            COALESCE(CAST(session_date AS STRING), ''),
            COALESCE(CAST(coin_in AS STRING), '')
        )) AS record_hash,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('casino', 'player_sessions') }}

    {% if is_incremental() %}
        WHERE ingestion_timestamp > (SELECT MAX(ingestion_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE session_id IS NOT NULL
  AND player_id IS NOT NULL
