{{ config(
    materialized='incremental',
    unique_key='session_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'player', 'sessions', 'gaming']
) }}

/*
    Silver Layer — Cleaned Player Sessions

    Transforms raw player tracking sessions with:
    - Duration calculation and validation
    - Win/loss categorization and net result
    - Average Daily Theoretical (ADT) calculation
    - Session rating based on coin-in and duration
    - Player tier enrichment

    All data is ENTIRELY SYNTHETIC.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_player_sessions') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            session_id,
            player_id,
            CAST(session_date AS STRING)
        )) AS session_sk,

        -- Session identifiers
        session_id,
        player_id,
        machine_id,

        -- Timing
        session_date,
        session_start,
        duration_minutes,

        -- Duration categorization
        CASE
            WHEN duration_minutes < 15 THEN 'BRIEF'
            WHEN duration_minutes < 60 THEN 'SHORT'
            WHEN duration_minutes < 120 THEN 'MEDIUM'
            WHEN duration_minutes < 240 THEN 'LONG'
            ELSE 'EXTENDED'
        END AS session_duration_category,

        -- Game type
        game_type,
        denomination,

        -- Financial metrics
        coin_in,
        coin_out,
        theoretical_win,
        actual_win,

        -- Net result (positive = house wins, negative = player wins)
        ROUND(coin_in - coin_out, 2) AS net_result,

        -- Win/loss classification
        CASE
            WHEN coin_in - coin_out > 0 THEN 'HOUSE_WIN'
            WHEN coin_in - coin_out < 0 THEN 'PLAYER_WIN'
            ELSE 'PUSH'
        END AS win_loss_category,

        -- Hold percentage for this session
        CASE
            WHEN coin_in > 0
            THEN ROUND((coin_in - coin_out) / coin_in * 100, 2)
            ELSE 0.0
        END AS session_hold_pct,

        -- Average bet per spin estimate
        CASE
            WHEN duration_minutes > 0 AND denomination > 0
            THEN ROUND(coin_in / (duration_minutes * 8), 2)  -- ~8 spins/min average
            ELSE NULL
        END AS avg_bet_estimate,

        -- ADT (Average Daily Theoretical) contribution from this session
        -- Theoretical win annualized to daily average
        CASE
            WHEN theoretical_win IS NOT NULL
            THEN ROUND(theoretical_win, 2)
            ELSE ROUND(coin_in * 0.06, 2)  -- Assume ~6% house edge if no theo provided
        END AS session_theoretical,

        -- Session rating (1-5 scale based on theo win)
        CASE
            WHEN theoretical_win >= 500 THEN 5
            WHEN theoretical_win >= 200 THEN 4
            WHEN theoretical_win >= 75 THEN 3
            WHEN theoretical_win >= 25 THEN 2
            ELSE 1
        END AS session_rating,

        -- Floor location
        floor_zone,

        -- Day-of-week analytics
        DAYOFWEEK(session_date) AS day_of_week,
        CASE
            WHEN DAYOFWEEK(session_date) IN (1, 7) THEN 'WEEKEND'
            ELSE 'WEEKDAY'
        END AS day_type,

        -- Time-of-day analytics
        CASE
            WHEN session_start IS NOT NULL THEN
                CASE
                    WHEN HOUR(session_start) BETWEEN 6 AND 11 THEN 'MORNING'
                    WHEN HOUR(session_start) BETWEEN 12 AND 17 THEN 'AFTERNOON'
                    WHEN HOUR(session_start) BETWEEN 18 AND 23 THEN 'EVENING'
                    ELSE 'LATE_NIGHT'
                END
            ELSE 'UNKNOWN'
        END AS time_of_day,

        -- Data quality
        CASE
            WHEN coin_in >= 0
                 AND coin_out >= 0
                 AND duration_minutes > 0
                 AND session_date IS NOT NULL
            THEN TRUE
            ELSE FALSE
        END AS is_valid,

        -- Metadata
        source_system,
        ingestion_timestamp,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
WHERE is_valid = TRUE
