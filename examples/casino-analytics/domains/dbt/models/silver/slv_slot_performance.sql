{{ config(
    materialized='incremental',
    unique_key='machine_period_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'slot', 'performance', 'gaming'],
    on_schema_change='fail'
) }}

/*
    Silver Layer — Aggregated Slot Machine Performance

    Aggregates raw slot telemetry events by machine and time period to produce
    operational metrics: hold percentage, games played, revenue, and uptime.

    Aggregation grain: machine_id × floor_zone × date

    All data is ENTIRELY SYNTHETIC.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_slot_events') }}
    WHERE is_valid_record = TRUE
      AND event_type IN ('SPIN', 'JACKPOT', 'BONUS', 'CASH_IN', 'CASH_OUT')

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Aggregate events by machine and date
daily_machine_metrics AS (
    SELECT
        machine_id,
        floor_zone,
        denomination,
        CAST(event_timestamp AS DATE) AS metric_date,

        -- Volume metrics
        COUNT(CASE WHEN event_type = 'SPIN' THEN 1 END) AS total_spins,
        COUNT(CASE WHEN event_type = 'JACKPOT' THEN 1 END) AS jackpot_count,
        COUNT(CASE WHEN event_type = 'BONUS' THEN 1 END) AS bonus_count,

        -- Financial metrics (credits × denomination = dollars)
        SUM(CASE WHEN event_type = 'SPIN' THEN credits_wagered * denomination ELSE 0 END) AS total_coin_in,
        SUM(CASE WHEN event_type IN ('SPIN', 'JACKPOT', 'BONUS') THEN credits_won * denomination ELSE 0 END) AS total_coin_out,

        -- Cash transactions
        SUM(CASE WHEN event_type = 'CASH_IN' THEN credits_wagered * denomination ELSE 0 END) AS total_cash_in,
        SUM(CASE WHEN event_type = 'CASH_OUT' THEN credits_won * denomination ELSE 0 END) AS total_cash_out,

        -- Player metrics
        COUNT(DISTINCT player_id) AS unique_players,
        COUNT(DISTINCT session_id) AS unique_sessions,

        -- RTP tracking
        AVG(rtp_contribution) AS avg_rtp_contribution,

        -- Active hours estimate (distinct hours with events)
        COUNT(DISTINCT HOUR(event_timestamp)) AS active_hours,

        -- Timestamp range
        MIN(event_timestamp) AS first_event_time,
        MAX(event_timestamp) AS last_event_time

    FROM base
    GROUP BY
        machine_id,
        floor_zone,
        denomination,
        CAST(event_timestamp AS DATE)
),

enriched AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            machine_id,
            floor_zone,
            CAST(metric_date AS STRING)
        )) AS machine_period_sk,

        -- Machine identifiers
        machine_id,
        floor_zone,
        denomination,
        metric_date,

        -- Volume metrics
        total_spins,
        jackpot_count,
        bonus_count,

        -- Financial metrics
        ROUND(total_coin_in, 2) AS total_coin_in,
        ROUND(total_coin_out, 2) AS total_coin_out,
        ROUND(total_cash_in, 2) AS total_cash_in,
        ROUND(total_cash_out, 2) AS total_cash_out,

        -- Revenue (net win to house)
        ROUND(total_coin_in - total_coin_out, 2) AS net_revenue,

        -- Hold percentage (actual)
        CASE
            WHEN total_coin_in > 0
            THEN ROUND((total_coin_in - total_coin_out) / total_coin_in * 100, 2)
            ELSE 0.0
        END AS actual_hold_pct,

        -- Hold variance from target
        CASE
            WHEN total_coin_in > 0
            THEN ROUND(
                ((total_coin_in - total_coin_out) / total_coin_in * 100)
                - {{ var('target_hold_pct') }}, 2
            )
            ELSE NULL
        END AS hold_variance_pct,

        -- Hold alert flag
        CASE
            WHEN total_coin_in > 0
                 AND ABS(((total_coin_in - total_coin_out) / total_coin_in * 100) - {{ var('target_hold_pct') }})
                     > {{ var('hold_variance_alert') }}
            THEN TRUE
            ELSE FALSE
        END AS hold_variance_alert,

        -- Player metrics
        unique_players,
        unique_sessions,

        -- RTP
        ROUND(avg_rtp_contribution, 4) AS avg_rtp_contribution,

        -- Utilization
        active_hours,
        ROUND(active_hours / 24.0 * 100, 1) AS uptime_pct,

        -- Games per hour
        CASE
            WHEN active_hours > 0
            THEN ROUND(total_spins::DECIMAL / active_hours, 0)
            ELSE 0
        END AS spins_per_hour,

        -- Revenue per player
        CASE
            WHEN unique_players > 0
            THEN ROUND((total_coin_in - total_coin_out) / unique_players, 2)
            ELSE 0.0
        END AS revenue_per_player,

        -- Day-of-week
        DAYOFWEEK(metric_date) AS day_of_week,
        CASE
            WHEN DAYOFWEEK(metric_date) IN (1, 7) THEN 'WEEKEND'
            ELSE 'WEEKDAY'
        END AS day_type,

        -- Timestamp range
        first_event_time,
        last_event_time,

        -- Data quality
        TRUE AS is_valid,

        -- Metadata
        'SLOT_MGMT_SYSTEM' AS source_system,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM daily_machine_metrics
)

SELECT * FROM enriched
WHERE total_spins > 0  -- Exclude days with only cash events and no play
