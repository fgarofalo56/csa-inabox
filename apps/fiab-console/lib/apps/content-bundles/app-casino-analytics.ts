/**
 * Casino Analytics — app-install content bundle.
 *
 * Content sourced from examples/casino-analytics/: README.md, dbt project,
 * bronze/silver/gold dbt models, streaming/kql_queries.kql,
 * contracts/player-analytics.yaml, and the two Databricks notebooks
 * (player_value_analysis.py, floor_optimization.py).
 *
 * Provisions a casino data warehouse (player-grain facts + dims, dbt models,
 * starter analyst queries), a high-roller Activator rule (Teams alert when
 * a player's net win exceeds $50,000 in a 1-hour window), and two starter
 * notebooks for player-value RFM/LTV/churn analysis and floor optimization.
 */

import type { AppBundle } from './types';
import type { NotebookCell } from '@/lib/types/notebook-cell';

function cell(
  type: 'code' | 'markdown',
  source: string,
  lang: NotebookCell['lang'] = 'pyspark',
): NotebookCell {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `cell-${Math.random().toString(36).slice(2, 10)}`;
  return type === 'code'
    ? { id, type, lang, source }
    : { id, type, source };
}

// ─── Warehouse DDL ──────────────────────────────────────────────────────
// Player-grain casino data warehouse: dim_player, dim_table, fact_session,
// fact_handle. Schema reflects the silver/gold patterns in the dbt
// reference architecture (slv_player_sessions, slv_slot_performance,
// gld_player_value) translated into a star schema for analyst consumption.

const WAREHOUSE_DDL = `-- ════════════════════════════════════════════════════════════════════
-- Casino Analytics Data Warehouse
-- Star schema: player-grain facts (sessions, individual hands/spins) with
-- supporting dimensions for players, tables/machines, dates, and zones.
-- Compliance: NIGC MICS, Title 31 BSA/AML. All seed data is synthetic.
-- ════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS casino;

-- ─── Dimensions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS casino.dim_player (
    player_sk           BIGINT          NOT NULL,
    player_id           VARCHAR(64)     NOT NULL,
    player_first_name   VARCHAR(80)     NULL,
    player_last_name    VARCHAR(80)     NULL,
    enrollment_date     DATE            NULL,
    tier                VARCHAR(16)     NOT NULL DEFAULT 'BRONZE',
    tier_qualified_at   TIMESTAMP       NULL,
    home_state          CHAR(2)         NULL,
    date_of_birth       DATE            NULL,
    self_excluded       BIT             NOT NULL DEFAULT 0,
    do_not_market       BIT             NOT NULL DEFAULT 0,
    lifetime_adt        DECIMAL(12, 2)  NULL,
    last_visit_date     DATE            NULL,
    is_current          BIT             NOT NULL DEFAULT 1,
    valid_from          TIMESTAMP       NOT NULL,
    valid_to            TIMESTAMP       NULL,
    CONSTRAINT pk_dim_player PRIMARY KEY (player_sk),
    CONSTRAINT ck_dim_player_tier CHECK (tier IN ('BRONZE','SILVER','GOLD','PLATINUM','DIAMOND'))
);

CREATE TABLE IF NOT EXISTS casino.dim_table (
    table_sk            BIGINT          NOT NULL,
    table_id            VARCHAR(32)     NOT NULL,
    table_type          VARCHAR(32)     NOT NULL,  -- SLOT, BLACKJACK, POKER, ROULETTE, BACCARAT, CRAPS
    game_theme          VARCHAR(80)     NULL,
    denomination        DECIMAL(6, 2)   NULL,
    floor_zone          VARCHAR(8)      NOT NULL,
    min_bet             DECIMAL(8, 2)   NULL,
    max_bet             DECIMAL(10, 2)  NULL,
    target_hold_pct     DECIMAL(5, 2)   NOT NULL DEFAULT 8.00,
    par_sheet_rtp_pct   DECIMAL(5, 2)   NULL,
    install_date        DATE            NULL,
    last_service_date   DATE            NULL,
    is_active           BIT             NOT NULL DEFAULT 1,
    CONSTRAINT pk_dim_table PRIMARY KEY (table_sk),
    CONSTRAINT ck_dim_table_zone CHECK (floor_zone IN ('A1','A2','B1','B2','C1','C2','D1','VIP'))
);

CREATE TABLE IF NOT EXISTS casino.dim_date (
    date_sk             INT             NOT NULL,    -- yyyymmdd
    full_date           DATE            NOT NULL,
    day_of_week         TINYINT         NOT NULL,
    day_name            VARCHAR(10)     NOT NULL,
    is_weekend          BIT             NOT NULL,
    is_holiday          BIT             NOT NULL DEFAULT 0,
    holiday_name        VARCHAR(64)     NULL,
    week_of_year        TINYINT         NOT NULL,
    month_num           TINYINT         NOT NULL,
    month_name          VARCHAR(10)     NOT NULL,
    quarter_num         TINYINT         NOT NULL,
    year_num            SMALLINT        NOT NULL,
    fiscal_period       VARCHAR(8)      NULL,
    gaming_day_start    TIMESTAMP       NOT NULL,    -- 06:00 local
    CONSTRAINT pk_dim_date PRIMARY KEY (date_sk)
);

-- ─── Facts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS casino.fact_session (
    session_sk          BIGINT          NOT NULL,
    session_id          VARCHAR(64)     NOT NULL,
    player_sk           BIGINT          NOT NULL,
    table_sk            BIGINT          NOT NULL,
    date_sk             INT             NOT NULL,
    session_start       TIMESTAMP       NOT NULL,
    session_end         TIMESTAMP       NULL,
    duration_minutes    INT             NULL,
    game_type           VARCHAR(32)     NOT NULL,
    coin_in             DECIMAL(14, 2)  NOT NULL DEFAULT 0,
    coin_out            DECIMAL(14, 2)  NOT NULL DEFAULT 0,
    theoretical_win     DECIMAL(14, 2)  NOT NULL DEFAULT 0,
    actual_win          DECIMAL(14, 2)  NOT NULL DEFAULT 0,
    net_result          DECIMAL(14, 2)  GENERATED ALWAYS AS (coin_in - coin_out) STORED,
    avg_bet             DECIMAL(8, 2)   NULL,
    rated_play          BIT             NOT NULL DEFAULT 1,
    comp_value          DECIMAL(10, 2)  NULL,
    session_rating      TINYINT         NULL,         -- 1-5
    floor_zone          VARCHAR(8)      NOT NULL,
    ingest_ts           TIMESTAMP       NOT NULL,
    CONSTRAINT pk_fact_session PRIMARY KEY (session_sk),
    CONSTRAINT fk_session_player FOREIGN KEY (player_sk) REFERENCES casino.dim_player(player_sk),
    CONSTRAINT fk_session_table  FOREIGN KEY (table_sk)  REFERENCES casino.dim_table(table_sk),
    CONSTRAINT fk_session_date   FOREIGN KEY (date_sk)   REFERENCES casino.dim_date(date_sk)
);
CREATE INDEX IF NOT EXISTS ix_fact_session_player_date ON casino.fact_session (player_sk, date_sk);
CREATE INDEX IF NOT EXISTS ix_fact_session_zone_date   ON casino.fact_session (floor_zone, date_sk);

-- Grain: one row per individual handle event (slot spin, table hand, jackpot,
-- bonus, cash-in, cash-out). Volume ~50M/day; partition by date_sk.
CREATE TABLE IF NOT EXISTS casino.fact_handle (
    handle_sk           BIGINT          NOT NULL,
    event_id            VARCHAR(64)     NOT NULL,
    session_sk          BIGINT          NULL,         -- NULL for unrated play
    player_sk           BIGINT          NULL,
    table_sk            BIGINT          NOT NULL,
    date_sk             INT             NOT NULL,
    event_ts            TIMESTAMP       NOT NULL,
    event_type          VARCHAR(16)     NOT NULL,     -- SPIN, JACKPOT, BONUS, CASH_IN, CASH_OUT, HAND_PAY, TILT
    denomination        DECIMAL(6, 2)   NOT NULL,
    credits_wagered     INT             NULL,
    credits_won         INT             NULL,
    coin_in_amount      DECIMAL(12, 2)  GENERATED ALWAYS AS (credits_wagered * denomination) STORED,
    coin_out_amount     DECIMAL(12, 2)  GENERATED ALWAYS AS (credits_won * denomination) STORED,
    jackpot_amount      DECIMAL(12, 2)  NULL,
    hand_pay_amount     DECIMAL(12, 2)  NULL,
    progressive_pool_id VARCHAR(32)     NULL,
    rtp_contribution    DECIMAL(8, 4)   NULL,
    floor_zone          VARCHAR(8)      NOT NULL,
    ctr_trigger         BIT             NOT NULL DEFAULT 0,  -- Title 31 $10K event
    tilt_code           VARCHAR(16)     NULL,
    ingest_ts           TIMESTAMP       NOT NULL,
    CONSTRAINT pk_fact_handle PRIMARY KEY (handle_sk, date_sk),
    CONSTRAINT ck_fact_handle_event CHECK (event_type IN
        ('SPIN','JACKPOT','BONUS','CASH_IN','CASH_OUT','HAND_PAY','TILT','DOOR_OPEN'))
)
PARTITION BY RANGE (date_sk);
CREATE INDEX IF NOT EXISTS ix_fact_handle_table_ts   ON casino.fact_handle (table_sk, event_ts);
CREATE INDEX IF NOT EXISTS ix_fact_handle_player_ts  ON casino.fact_handle (player_sk, event_ts);
CREATE INDEX IF NOT EXISTS ix_fact_handle_ctr        ON casino.fact_handle (ctr_trigger, date_sk) WHERE ctr_trigger = 1;
`;

// ─── dbt project.yml ────────────────────────────────────────────────────
const DBT_PROJECT_YML = `name: 'csa_casino'
version: '1.0.0'
config-version: 2
require-dbt-version: [">=1.7.0", "<2.0.0"]

profile: 'casino_analytics'

model-paths: ["models"]
seed-paths: ["seeds"]
macro-paths: ["../../../domains/shared/dbt/macros"]

vars:
  bronze_database: "bronze"
  silver_database: "silver"
  gold_database: "gold"
  file_format: "delta"
  incremental_strategy: "merge"
  freshness_warn_hours: 24
  freshness_error_hours: 48

  # Casino-specific variables
  gaming_day_start_hour: 6          # Gaming day starts at 6:00 AM local
  ctr_threshold: 10000              # Title 31 CTR threshold ($10,000)
  structuring_threshold: 8000       # Structuring detection lower bound
  lookback_days: 90                 # Default analysis window

  # Player tier thresholds (ADT-based)
  tier_thresholds:
    bronze: 0
    silver: 50
    gold: 150
    platinum: 400
    diamond: 1500

  # Slot machine configuration
  target_hold_pct: 8.0
  hold_variance_alert: 2.0

  # Floor zones
  floor_zones: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'VIP']

  # Churn risk thresholds
  churn_high_risk_days: 45
  churn_medium_risk_days: 30

models:
  csa_casino:
    bronze:
      +materialized: incremental
      +file_format: delta
      +schema: bronze
      +tags: ['bronze', 'casino', 'raw']
      +unique_key: ['source_system', 'ingestion_timestamp', 'record_hash']
    silver:
      +materialized: incremental
      +file_format: delta
      +schema: silver
      +tags: ['silver', 'casino', 'cleaned']
      +incremental_strategy: merge
      +on_schema_change: "sync_all_columns"
    gold:
      +materialized: table
      +file_format: delta
      +schema: gold
      +tags: ['gold', 'casino', 'analytics']
      +post-hook: "OPTIMIZE {{ this }} ZORDER BY (reporting_date)"

seeds:
  csa_casino:
    +schema: seeds
    +tags: ['seed', 'casino', 'synthetic']

snapshots:
  csa_casino:
    +target_schema: snapshots
    +strategy: timestamp
    +updated_at: processed_timestamp
`;

// ─── dbt models (bronze / silver / gold) ────────────────────────────────

const DBT_BRZ_SLOT_EVENTS = `{{ config(
    materialized='incremental',
    unique_key=['event_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'slot', 'telemetry', 'streaming'],
    on_schema_change='fail'
) }}

/*
    Bronze Layer — Raw Slot Machine Telemetry

    Source: Slot Management System via Event Hub -> Stream Analytics -> ADLS.
    Captures spin events, jackpots, bonus rounds, and error/tilt conditions
    from SAS-protocol slot machines. ~50M events/day in production.
    All data is ENTIRELY SYNTHETIC.
*/

WITH source_data AS (
    SELECT
        'SLOT_MGMT_SYSTEM' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,
        CAST(event_id AS STRING) AS event_id,
        CAST(machine_id AS STRING) AS machine_id,
        CAST(event_timestamp AS TIMESTAMP) AS event_timestamp,
        UPPER(TRIM(event_type)) AS event_type,
        CAST(denomination AS DECIMAL(6,2)) AS denomination,
        CAST(credits_wagered AS INT) AS credits_wagered,
        CAST(credits_won AS INT) AS credits_won,
        CAST(rtp_contribution AS DECIMAL(8,4)) AS rtp_contribution,
        UPPER(TRIM(floor_zone)) AS floor_zone,
        CAST(player_id AS STRING) AS player_id,
        CAST(session_id AS STRING) AS session_id,
        CASE
            WHEN event_id IS NULL THEN FALSE
            WHEN machine_id IS NULL THEN FALSE
            WHEN event_timestamp IS NULL THEN FALSE
            WHEN event_type NOT IN ('SPIN','JACKPOT','BONUS','ERROR','CASH_IN','CASH_OUT','TILT') THEN FALSE
            WHEN denomination IS NULL OR denomination <= 0 THEN FALSE
            WHEN credits_wagered IS NOT NULL AND credits_wagered < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,
        MD5(CONCAT_WS('|',
            COALESCE(CAST(event_id AS STRING), ''),
            COALESCE(CAST(machine_id AS STRING), ''),
            COALESCE(CAST(event_timestamp AS STRING), '')
        )) AS record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at
    FROM {{ source('casino', 'slot_events') }}
    {% if is_incremental() %}
        WHERE event_timestamp > (SELECT MAX(event_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE event_id IS NOT NULL
  AND machine_id IS NOT NULL
`;

const DBT_BRZ_PLAYER_SESSIONS = `{{ config(
    materialized='incremental',
    unique_key=['session_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'player', 'sessions', 'gaming'],
    on_schema_change='fail'
) }}

/*
    Bronze Layer — Raw Player Tracking Sessions

    Source: Player Tracking System (PTS) nightly extract. Captures rated
    play sessions from slot machines and table games with coin-in/coin-out,
    theoretical win, and tier information. This is the upstream dependency
    of slv_player_sessions (and therefore gld_player_value). Without it the
    silver/gold dbt graph cannot compile. All data is ENTIRELY SYNTHETIC.
*/

WITH source_data AS (
    SELECT
        'PLAYER_TRACKING' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,
        CAST(session_id AS STRING) AS session_id,
        CAST(player_id AS STRING) AS player_id,
        CAST(machine_id AS STRING) AS machine_id,
        CAST(session_date AS DATE) AS session_date,
        CAST(session_start AS TIMESTAMP) AS session_start,
        CAST(duration_minutes AS INT) AS duration_minutes,
        UPPER(TRIM(game_type)) AS game_type,
        CAST(coin_in AS DECIMAL(12,2)) AS coin_in,
        CAST(coin_out AS DECIMAL(12,2)) AS coin_out,
        CAST(theoretical_win AS DECIMAL(12,2)) AS theoretical_win,
        CAST(actual_win AS DECIMAL(12,2)) AS actual_win,
        CAST(denomination AS DECIMAL(6,2)) AS denomination,
        UPPER(TRIM(floor_zone)) AS floor_zone,
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
        MD5(CONCAT_WS('|',
            COALESCE(CAST(session_id AS STRING), ''),
            COALESCE(CAST(player_id AS STRING), ''),
            COALESCE(CAST(session_date AS STRING), ''),
            COALESCE(CAST(coin_in AS STRING), '')
        )) AS record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at
    FROM {{ source('casino', 'player_sessions') }}
    {% if is_incremental() %}
        WHERE ingestion_timestamp > (SELECT MAX(ingestion_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE session_id IS NOT NULL
  AND player_id IS NOT NULL
`;

const DBT_SLV_PLAYER_SESSIONS = `{{ config(
    materialized='incremental',
    unique_key='session_sk',
    tags=['silver', 'player', 'sessions', 'gaming'],
    on_schema_change='fail'
) }}

/*
    Silver Layer — Cleaned Player Sessions
    Standardizes player tracking sessions with duration buckets, win/loss
    classification, hold percentage, session rating (1-5), and gaming-day
    boundaries. All data is ENTIRELY SYNTHETIC.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_player_sessions') }} WHERE is_valid_record = TRUE
    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
)

SELECT
    MD5(CONCAT_WS('|', session_id, player_id, CAST(session_date AS STRING))) AS session_sk,
    session_id, player_id, machine_id,
    session_date, session_start, duration_minutes,
    CASE
        WHEN duration_minutes < 15 THEN 'BRIEF'
        WHEN duration_minutes < 60 THEN 'SHORT'
        WHEN duration_minutes < 120 THEN 'MEDIUM'
        WHEN duration_minutes < 240 THEN 'LONG'
        ELSE 'EXTENDED'
    END AS session_duration_category,
    game_type, denomination, coin_in, coin_out,
    theoretical_win, actual_win,
    ROUND(coin_in - coin_out, 2) AS net_result,
    CASE
        WHEN coin_in - coin_out > 0 THEN 'HOUSE_WIN'
        WHEN coin_in - coin_out < 0 THEN 'PLAYER_WIN'
        ELSE 'PUSH'
    END AS win_loss_category,
    CASE WHEN coin_in > 0 THEN ROUND((coin_in - coin_out) / coin_in * 100, 2) ELSE 0.0 END AS session_hold_pct,
    CASE
        WHEN theoretical_win >= 500 THEN 5
        WHEN theoretical_win >= 200 THEN 4
        WHEN theoretical_win >=  75 THEN 3
        WHEN theoretical_win >=  25 THEN 2
        ELSE 1
    END AS session_rating,
    floor_zone,
    DAYOFWEEK(session_date) AS day_of_week,
    CASE WHEN DAYOFWEEK(session_date) IN (1,7) THEN 'WEEKEND' ELSE 'WEEKDAY' END AS day_type,
    CASE
        WHEN session_start IS NOT NULL THEN
            CASE
                WHEN HOUR(session_start) BETWEEN  6 AND 11 THEN 'MORNING'
                WHEN HOUR(session_start) BETWEEN 12 AND 17 THEN 'AFTERNOON'
                WHEN HOUR(session_start) BETWEEN 18 AND 23 THEN 'EVENING'
                ELSE 'LATE_NIGHT'
            END
        ELSE 'UNKNOWN'
    END AS time_of_day,
    source_system, ingestion_timestamp, record_hash,
    CURRENT_TIMESTAMP() AS _dbt_loaded_at
FROM base
WHERE coin_in >= 0 AND coin_out >= 0 AND duration_minutes > 0
`;

const DBT_SLV_SLOT_PERFORMANCE = `{{ config(
    materialized='incremental',
    unique_key='machine_period_sk',
    tags=['silver', 'slot', 'performance']
) }}

/*
    Silver Layer — Aggregated Slot Machine Performance (machine x zone x day).
    Produces hold percentage variance vs target, jackpot frequency, uptime,
    and revenue-per-player. Drives the floor-optimization gold model.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_slot_events') }}
    WHERE is_valid_record = TRUE
      AND event_type IN ('SPIN','JACKPOT','BONUS','CASH_IN','CASH_OUT')
)

SELECT
    MD5(CONCAT_WS('|', machine_id, floor_zone, CAST(CAST(event_timestamp AS DATE) AS STRING))) AS machine_period_sk,
    machine_id, floor_zone, denomination,
    CAST(event_timestamp AS DATE) AS metric_date,
    COUNT(CASE WHEN event_type = 'SPIN' THEN 1 END) AS total_spins,
    COUNT(CASE WHEN event_type = 'JACKPOT' THEN 1 END) AS jackpot_count,
    COUNT(CASE WHEN event_type = 'BONUS' THEN 1 END) AS bonus_count,
    ROUND(SUM(CASE WHEN event_type = 'SPIN' THEN credits_wagered * denomination ELSE 0 END), 2) AS total_coin_in,
    ROUND(SUM(CASE WHEN event_type IN ('SPIN','JACKPOT','BONUS') THEN credits_won * denomination ELSE 0 END), 2) AS total_coin_out,
    COUNT(DISTINCT player_id)  AS unique_players,
    COUNT(DISTINCT session_id) AS unique_sessions,
    AVG(rtp_contribution) AS avg_rtp_contribution,
    COUNT(DISTINCT HOUR(event_timestamp)) AS active_hours,
    CASE
        WHEN SUM(CASE WHEN event_type='SPIN' THEN credits_wagered * denomination END) > 0
        THEN ROUND(
            (SUM(CASE WHEN event_type='SPIN' THEN credits_wagered * denomination END) -
             SUM(CASE WHEN event_type IN ('SPIN','JACKPOT','BONUS') THEN credits_won * denomination END))
            / SUM(CASE WHEN event_type='SPIN' THEN credits_wagered * denomination END) * 100, 2)
        ELSE 0.0
    END AS actual_hold_pct,
    {{ var('target_hold_pct') }} AS target_hold_pct,
    CURRENT_TIMESTAMP() AS _dbt_loaded_at
FROM base
GROUP BY machine_id, floor_zone, denomination, CAST(event_timestamp AS DATE)
`;

const DBT_GLD_PLAYER_VALUE = `{{ config(
    materialized='table',
    tags=['gold', 'player', 'lifetime_value']
) }}

/*
    Gold Layer — Player Lifetime Value & Churn Model

    For each player, computes lifetime ADT (Average Daily Theoretical),
    visit-frequency-per-month, RFM-based churn probability, calculated tier,
    and comp efficiency (comp value as % of theoretical win — should be < 40%).
    Consumed by player-development hosts and marketing campaigns.
*/

WITH player_session_summary AS (
    SELECT
        player_id,
        COUNT(*)                                   AS total_sessions,
        COUNT(DISTINCT session_date)               AS total_visit_days,
        MIN(session_date)                          AS first_visit_date,
        MAX(session_date)                          AS last_visit_date,
        DATEDIFF(CURRENT_DATE(), MAX(session_date)) AS days_since_last_visit,
        SUM(coin_in)                               AS lifetime_coin_in,
        SUM(coin_out)                              AS lifetime_coin_out,
        SUM(theoretical_win)                       AS lifetime_theoretical,
        SUM(net_result)                            AS lifetime_net_result,
        AVG(duration_minutes)                      AS avg_session_duration,
        CASE WHEN DATEDIFF(MAX(session_date), MIN(session_date)) > 0
            THEN COUNT(DISTINCT session_date)::DECIMAL
                 / (DATEDIFF(MAX(session_date), MIN(session_date)) / 30.0)
            ELSE COUNT(DISTINCT session_date)
        END AS visits_per_month,
        MODE(game_type)    AS preferred_game_type,
        MODE(denomination) AS preferred_denomination,
        MODE(floor_zone)   AS preferred_zone
    FROM {{ ref('slv_player_sessions') }}
    GROUP BY player_id
)
SELECT
    player_id,
    total_sessions, total_visit_days, first_visit_date, last_visit_date,
    days_since_last_visit, ROUND(visits_per_month, 2) AS visits_per_month,
    ROUND(lifetime_coin_in, 2)      AS lifetime_coin_in,
    ROUND(lifetime_coin_out, 2)     AS lifetime_coin_out,
    ROUND(lifetime_theoretical, 2)  AS lifetime_theoretical,
    ROUND(lifetime_net_result, 2)   AS lifetime_net_result,
    CASE WHEN total_visit_days > 0
        THEN ROUND(lifetime_theoretical / total_visit_days, 2) ELSE 0.0
    END AS adt,
    CASE
        WHEN lifetime_theoretical / NULLIF(total_visit_days, 0) >= {{ var('tier_thresholds')['diamond']  }} THEN 'DIAMOND'
        WHEN lifetime_theoretical / NULLIF(total_visit_days, 0) >= {{ var('tier_thresholds')['platinum'] }} THEN 'PLATINUM'
        WHEN lifetime_theoretical / NULLIF(total_visit_days, 0) >= {{ var('tier_thresholds')['gold']     }} THEN 'GOLD'
        WHEN lifetime_theoretical / NULLIF(total_visit_days, 0) >= {{ var('tier_thresholds')['silver']   }} THEN 'SILVER'
        ELSE 'BRONZE'
    END AS calculated_tier,
    CASE
        WHEN days_since_last_visit <=  7 THEN 100
        WHEN days_since_last_visit <= 14 THEN  85
        WHEN days_since_last_visit <= 30 THEN  70
        WHEN days_since_last_visit <= 45 THEN  50
        WHEN days_since_last_visit <= 60 THEN  30
        WHEN days_since_last_visit <= 90 THEN  15
        ELSE 5
    END AS recency_score,
    CASE
        WHEN visits_per_month >= 8   THEN 100
        WHEN visits_per_month >= 4   THEN  85
        WHEN visits_per_month >= 2   THEN  70
        WHEN visits_per_month >= 1   THEN  55
        WHEN visits_per_month >= 0.5 THEN  35
        ELSE 15
    END AS frequency_score,
    preferred_game_type, preferred_denomination, preferred_zone,
    CURRENT_DATE() AS reporting_date,
    CURRENT_TIMESTAMP() AS _dbt_loaded_at
FROM player_session_summary
ORDER BY lifetime_theoretical DESC
`;

const DBT_GLD_FLOOR_OPTIMIZATION = `{{ config(
    materialized='table',
    tags=['gold', 'floor', 'optimization']
) }}

/*
    Gold Layer — Floor Layout Optimization

    Zone-level revenue and utilization metrics with a composite optimization
    score (0-100) blending revenue-per-machine (40%), uptime (30%), hold
    accuracy (20%), and weekend lift (10%). Outputs a recommendation per
    zone: ADD_MACHINES / REMOVE_MACHINES / CHANGE_DENOMINATION_MIX /
    REVIEW_PAR_SHEETS / MONITOR.
*/

WITH zone_summary AS (
    SELECT
        floor_zone,
        MIN(metric_date) AS period_start,
        MAX(metric_date) AS period_end,
        COUNT(DISTINCT metric_date) AS active_days,
        AVG(active_hours)            AS avg_active_hours,
        ROUND(SUM(total_coin_in - total_coin_out), 2) AS total_revenue,
        ROUND(AVG(total_coin_in - total_coin_out), 2) AS avg_daily_revenue,
        ROUND(SUM(total_coin_in - total_coin_out) / NULLIF(AVG(unique_sessions) * COUNT(DISTINCT metric_date), 0), 2) AS revenue_per_machine_day,
        ROUND(SUM(total_coin_in - total_coin_out) / NULLIF(SUM(total_coin_in), 0) * 100, 2) AS overall_hold_pct,
        ROUND(AVG(actual_hold_pct - target_hold_pct), 2) AS hold_variance_from_target,
        SUM(jackpot_count)  AS total_jackpots,
        AVG(unique_players) AS avg_daily_players
    FROM {{ ref('slv_slot_performance') }}
    GROUP BY floor_zone
)
SELECT
    floor_zone,
    period_start, period_end, active_days,
    total_revenue, avg_daily_revenue, revenue_per_machine_day,
    overall_hold_pct, hold_variance_from_target,
    CASE
        WHEN ABS(COALESCE(hold_variance_from_target, 0)) <= 1.0 THEN 'ON_TARGET'
        WHEN hold_variance_from_target > 1.0  THEN 'ABOVE_TARGET'
        WHEN hold_variance_from_target < -1.0 THEN 'BELOW_TARGET'
        ELSE 'UNKNOWN'
    END AS hold_status,
    total_jackpots, ROUND(avg_daily_players, 0) AS avg_daily_players,
    ROUND(
        LEAST(revenue_per_machine_day / 50.0 * 40, 40) +
        LEAST(avg_active_hours        / 24.0 * 30, 30) +
        CASE
            WHEN ABS(COALESCE(hold_variance_from_target, 99)) <= 0.5 THEN 20
            WHEN ABS(COALESCE(hold_variance_from_target, 99)) <= 1.0 THEN 15
            WHEN ABS(COALESCE(hold_variance_from_target, 99)) <= 2.0 THEN 10
            ELSE 5
        END
    , 1) AS optimization_score,
    CASE
        WHEN revenue_per_machine_day < 20 AND avg_active_hours < 10 THEN 'REMOVE_MACHINES'
        WHEN revenue_per_machine_day < 30 AND avg_active_hours > 18 THEN 'CHANGE_DENOMINATION_MIX'
        WHEN revenue_per_machine_day > 80 AND avg_active_hours > 20 THEN 'ADD_MACHINES'
        WHEN ABS(COALESCE(hold_variance_from_target, 0)) > 2.0 THEN 'REVIEW_PAR_SHEETS'
        ELSE 'MONITOR'
    END AS optimization_recommendation,
    CURRENT_DATE() AS reporting_date,
    CURRENT_TIMESTAMP() AS _dbt_loaded_at
FROM zone_summary
ORDER BY optimization_score DESC
`;

// ─── Starter analyst queries ────────────────────────────────────────────

const STARTER_QUERY_VIP = `-- Top-50 VIPs in the last 90 days by theoretical win.
-- Used by player development hosts to prioritize outreach.
SELECT
    p.player_id,
    p.player_last_name,
    p.tier,
    COUNT(DISTINCT s.session_id)              AS sessions_90d,
    COUNT(DISTINCT s.date_sk)                 AS visit_days_90d,
    ROUND(SUM(s.coin_in),         2)          AS coin_in_90d,
    ROUND(SUM(s.theoretical_win), 2)          AS theo_win_90d,
    ROUND(SUM(s.actual_win),      2)          AS actual_win_90d,
    ROUND(SUM(s.theoretical_win) /
          NULLIF(COUNT(DISTINCT s.date_sk), 0), 2) AS adt_90d,
    ROUND(SUM(s.comp_value),      2)          AS comp_value_90d,
    ROUND(100.0 * SUM(s.comp_value) /
          NULLIF(SUM(s.theoretical_win), 0), 1) AS comp_efficiency_pct
FROM casino.fact_session s
JOIN casino.dim_player   p ON p.player_sk = s.player_sk
JOIN casino.dim_date     d ON d.date_sk   = s.date_sk
WHERE d.full_date >= DATEADD(day, -90, CURRENT_DATE)
  AND p.self_excluded = 0
GROUP BY p.player_id, p.player_last_name, p.tier
ORDER BY theo_win_90d DESC
LIMIT 50;
`;

const STARTER_QUERY_HOLD_BY_ZONE = `-- Hold percentage variance by zone in the last 30 days.
-- A zone that drifts more than 2% from target_hold (8%) triggers a par-sheet review.
SELECT
    t.floor_zone,
    COUNT(DISTINCT t.table_id)                     AS active_tables,
    SUM(h.coin_in_amount)                          AS total_coin_in,
    SUM(h.coin_out_amount)                         AS total_coin_out,
    ROUND(100.0 *
          (SUM(h.coin_in_amount) - SUM(h.coin_out_amount)) /
          NULLIF(SUM(h.coin_in_amount), 0), 2)     AS actual_hold_pct,
    AVG(t.target_hold_pct)                         AS target_hold_pct,
    ROUND(100.0 *
          (SUM(h.coin_in_amount) - SUM(h.coin_out_amount)) /
          NULLIF(SUM(h.coin_in_amount), 0)
          - AVG(t.target_hold_pct), 2)             AS hold_variance_pct
FROM casino.fact_handle  h
JOIN casino.dim_table    t ON t.table_sk = h.table_sk
JOIN casino.dim_date     d ON d.date_sk  = h.date_sk
WHERE d.full_date >= DATEADD(day, -30, CURRENT_DATE)
  AND h.event_type = 'SPIN'
GROUP BY t.floor_zone
ORDER BY ABS(hold_variance_pct) DESC;
`;

const STARTER_QUERY_CTR = `-- Title 31 CTR pre-alert: players whose cash transactions in the last
-- gaming day (06:00 -> 05:59) approach or exceed $10,000.
SELECT
    p.player_id,
    p.player_last_name,
    p.tier,
    SUM(CASE WHEN h.event_type = 'CASH_IN'   THEN h.coin_in_amount  ELSE 0 END) AS cash_in_total,
    SUM(CASE WHEN h.event_type = 'CASH_OUT'  THEN h.coin_out_amount ELSE 0 END) AS cash_out_total,
    SUM(CASE WHEN h.event_type = 'HAND_PAY'  THEN h.hand_pay_amount ELSE 0 END) AS hand_pay_total,
    MAX(CASE WHEN h.event_type = 'CASH_IN'   THEN h.coin_in_amount  ELSE 0 END) AS max_single_cash_in,
    COUNT(*)                                                                    AS event_count,
    CASE
        WHEN SUM(CASE WHEN h.event_type = 'CASH_IN'  THEN h.coin_in_amount  ELSE 0 END) +
             SUM(CASE WHEN h.event_type = 'HAND_PAY' THEN h.hand_pay_amount ELSE 0 END) >= 10000
            THEN 'CTR_REQUIRED'
        WHEN SUM(CASE WHEN h.event_type = 'CASH_IN'  THEN h.coin_in_amount  ELSE 0 END) +
             SUM(CASE WHEN h.event_type = 'HAND_PAY' THEN h.hand_pay_amount ELSE 0 END) >= 8000
            THEN 'APPROACHING'
        ELSE 'NORMAL'
    END AS ctr_status
FROM casino.fact_handle h
JOIN casino.dim_player  p ON p.player_sk = h.player_sk
JOIN casino.dim_date    d ON d.date_sk   = h.date_sk
WHERE h.event_ts >= DATEADD(hour, -24, CURRENT_TIMESTAMP)
  AND h.event_type IN ('CASH_IN', 'CASH_OUT', 'HAND_PAY')
  AND p.player_sk IS NOT NULL
GROUP BY p.player_id, p.player_last_name, p.tier
HAVING SUM(CASE WHEN h.event_type = 'CASH_IN'  THEN h.coin_in_amount  ELSE 0 END) +
       SUM(CASE WHEN h.event_type = 'HAND_PAY' THEN h.hand_pay_amount ELSE 0 END) >= 8000
ORDER BY (cash_in_total + hand_pay_total) DESC;
`;

const STARTER_QUERY_CHURN = `-- Churn-risk players (no visit in 30+ days) sorted by historical ADT.
-- Drives a "win-back" mail/email campaign from marketing.
SELECT
    p.player_id,
    p.player_last_name,
    p.tier,
    p.last_visit_date,
    DATEDIFF(day, p.last_visit_date, CURRENT_DATE)  AS days_since_last_visit,
    p.lifetime_adt,
    COUNT(DISTINCT s.session_id)                    AS sessions_lifetime,
    ROUND(SUM(s.theoretical_win), 2)                AS lifetime_theoretical
FROM casino.dim_player    p
LEFT JOIN casino.fact_session s ON s.player_sk = p.player_sk
WHERE p.self_excluded = 0
  AND p.do_not_market = 0
  AND DATEDIFF(day, p.last_visit_date, CURRENT_DATE) BETWEEN 30 AND 120
  AND p.lifetime_adt >= 50
GROUP BY p.player_id, p.player_last_name, p.tier, p.last_visit_date, p.lifetime_adt
ORDER BY p.lifetime_adt DESC, days_since_last_visit ASC
LIMIT 200;
`;

const STARTER_QUERY_FLOOR_PERF = `-- Daily floor performance by zone with hold variance flag.
-- Surfaces zones operating > 2% from target hold for floor-manager review.
SELECT
    d.full_date,
    t.floor_zone,
    COUNT(DISTINCT s.player_sk)                     AS unique_players,
    COUNT(s.session_sk)                             AS sessions,
    ROUND(SUM(s.coin_in),         2)                AS coin_in,
    ROUND(SUM(s.coin_out),        2)                AS coin_out,
    ROUND(SUM(s.theoretical_win), 2)                AS theoretical_win,
    ROUND(SUM(s.actual_win),      2)                AS actual_win,
    ROUND(100.0 *
          (SUM(s.coin_in) - SUM(s.coin_out)) /
          NULLIF(SUM(s.coin_in), 0), 2)             AS actual_hold_pct,
    AVG(t.target_hold_pct)                          AS target_hold_pct,
    CASE
        WHEN ABS(
            100.0 * (SUM(s.coin_in) - SUM(s.coin_out)) / NULLIF(SUM(s.coin_in), 0)
            - AVG(t.target_hold_pct)
        ) > 2.0 THEN 'VARIANCE_ALERT'
        ELSE 'OK'
    END AS hold_status
FROM casino.fact_session s
JOIN casino.dim_table    t ON t.table_sk = s.table_sk
JOIN casino.dim_date     d ON d.date_sk  = s.date_sk
WHERE d.full_date >= DATEADD(day, -7, CURRENT_DATE)
GROUP BY d.full_date, t.floor_zone
ORDER BY d.full_date DESC, ABS(actual_hold_pct - target_hold_pct) DESC;
`;

// ─── Notebook cells ─────────────────────────────────────────────────────
// Source: examples/casino-analytics/notebooks/player_value_analysis.py
// Split into logical cells along the original `# COMMAND ----------` markers.

const PVA_INTRO_MD = `# Player Value Analysis

Comprehensive player analytics for casino operations:

- Player segmentation and lifetime value (LTV) estimation
- Behavioral pattern analysis (session duration, game preferences)
- Cross-property spend analysis (gaming + F&B)
- RFM (Recency-Frequency-Monetary) scoring
- Churn risk identification
- Promotional ROI analysis

> All seed data is **entirely synthetic** — no real player data is included.
`;

const PVA_SETUP = `# Setup — common imports for RFM, churn modeling, and LTV forecasting.
import warnings
from datetime import timedelta

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

from pyspark.sql.functions import *

warnings.filterwarnings("ignore")
plt.style.use("seaborn-v0_8")
sns.set_palette("husl")
`;

const PVA_LOAD = `# Load silver-layer tables produced by the casino dbt project.
# Requires: slv_player_sessions, slv_slot_events, slv_fnb_transactions.

def load_casino_data():
    """Load all casino datasets."""
    sessions = spark.table("silver.slv_player_sessions").toPandas()
    slots = spark.table("silver.slv_slot_events").toPandas()
    fnb = spark.table("silver.slv_fnb_transactions").toPandas()

    sessions["session_date"] = pd.to_datetime(sessions["session_date"])
    fnb["transaction_date"] = pd.to_datetime(fnb["transaction_date"])

    print(f"Sessions: {len(sessions):,}")
    print(f"Slot events: {len(slots):,}")
    print(f"F&B transactions: {len(fnb):,}")
    print(f"Unique players: {sessions['player_id'].nunique()}")
    return sessions, slots, fnb


df_sessions, df_slots, df_fnb = load_casino_data()
`;

const PVA_RFM = `# RFM Analysis — assigns each player a (Recency, Frequency, Monetary) score
# bucket and a segment label (VIP / Loyal / Regular / New / At Risk / Lost).

def compute_rfm(sessions, fnb):
    """Compute RFM scores for player segmentation."""
    ref_date = sessions["session_date"].max() + timedelta(days=1)

    gaming_rfm = (
        sessions.groupby("player_id")
        .agg(
            recency_days=("session_date", lambda x: (ref_date - x.max()).days),
            frequency=("session_id", "count"),
            monetary_coin_in=("coin_in", "sum"),
            monetary_theo_win=("theoretical_win", "sum"),
            avg_duration=("duration_minutes", "mean"),
            total_actual_win=("actual_win", "sum"),
        )
        .reset_index()
    )

    fnb_spend = (
        fnb.groupby("player_id")
        .agg(fnb_total=("total", "sum"),
             fnb_visits=("transaction_id", "count"),
             comp_total=("comp_value", "sum"))
        .reset_index()
    )

    player_rfm = gaming_rfm.merge(fnb_spend, on="player_id", how="left").fillna(0)

    for col in ["recency_days", "frequency", "monetary_coin_in"]:
        if col == "recency_days":
            player_rfm[f"{col}_score"] = pd.qcut(
                player_rfm[col], 5, labels=[5, 4, 3, 2, 1], duplicates="drop"
            ).astype(int)
        else:
            player_rfm[f"{col}_score"] = pd.qcut(
                player_rfm[col].rank(method="first"), 5,
                labels=[1, 2, 3, 4, 5], duplicates="drop"
            ).astype(int)

    player_rfm["rfm_score"] = (
        player_rfm["recency_days_score"] * 100
        + player_rfm["frequency_score"] * 10
        + player_rfm["monetary_coin_in_score"]
    )

    def segment(row):
        r, f, m = row["recency_days_score"], row["frequency_score"], row["monetary_coin_in_score"]
        if r >= 4 and f >= 4 and m >= 4: return "VIP"
        if r >= 3 and f >= 3:            return "Loyal"
        if r >= 4 and f <= 2:            return "New"
        if r <= 2 and f >= 3:            return "At Risk"
        if r <= 2 and f <= 2:            return "Lost"
        return "Regular"

    player_rfm["segment"] = player_rfm.apply(segment, axis=1)
    return player_rfm


player_rfm = compute_rfm(df_sessions, df_fnb)
print(player_rfm["segment"].value_counts())
`;

const PVA_CHURN = `# Churn-Prediction Model — defines "churned" = no visit in 30+ days,
# trains three classifiers, logs everything to MLflow.
import mlflow
import mlflow.sklearn
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

mlflow.set_experiment("/Casino/player_value_analysis")


def build_churn_model(player_rfm, sessions):
    df_churn = player_rfm.copy()
    df_churn["is_churned"] = (df_churn["recency_days"] > 30).astype(int)

    session_stats = (
        sessions.groupby("player_id")
        .agg(
            session_count=("session_id", "count"),
            avg_session_duration=("duration_minutes", "mean"),
            std_session_duration=("duration_minutes", "std"),
            game_variety=("game_type", "nunique"),
            zones_visited=("floor_zone", "nunique"),
            avg_coin_in=("coin_in", "mean"),
            total_actual_win=("actual_win", "sum"),
        )
        .reset_index()
    )

    df_churn = df_churn.merge(session_stats, on="player_id", how="left").fillna(0)
    df_churn["win_rate"] = (
        df_churn["total_actual_win"] / df_churn["monetary_coin_in"].clip(lower=1)
    ).round(4)

    features = [
        "frequency", "monetary_coin_in", "monetary_theo_win", "fnb_total",
        "avg_duration", "session_count", "avg_session_duration",
        "std_session_duration", "game_variety", "zones_visited",
        "avg_coin_in", "win_rate", "comp_total",
    ]
    X = df_churn[features].fillna(0)
    y = df_churn["is_churned"]

    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, stratify=y, random_state=42)
    scaler = StandardScaler()
    X_tr_s = scaler.fit_transform(X_tr)
    X_te_s = scaler.transform(X_te)

    models = {
        "logreg": LogisticRegression(max_iter=1000, random_state=42),
        "rf":     RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42),
        "gbm":    GradientBoostingClassifier(n_estimators=100, max_depth=4, random_state=42),
    }

    results = {}
    for name, model in models.items():
        with mlflow.start_run(run_name=f"churn_{name}"):
            model.fit(X_tr_s, y_tr)
            y_pred = model.predict(X_te_s)
            y_prob = model.predict_proba(X_te_s)[:, 1]
            f1  = f1_score(y_te, y_pred)
            auc = roc_auc_score(y_te, y_prob)
            mlflow.log_metric("f1",  f1)
            mlflow.log_metric("auc", auc)
            mlflow.sklearn.log_model(model, f"churn_{name}")
            results[name] = {"model": model, "f1": f1, "auc": auc}
            print(f"{name}: F1={f1:.3f}, AUC={auc:.3f}")

    return df_churn, results


df_churn, churn_results = build_churn_model(player_rfm, df_sessions)
`;

const PVA_SAVE = `# Persist RFM segments and churn predictions to the Gold layer for
# downstream consumption by player-development hosts.

rfm_spark = spark.createDataFrame(
    player_rfm[[
        "player_id", "recency_days", "frequency",
        "monetary_coin_in", "monetary_theo_win", "total_actual_win",
        "fnb_total", "fnb_visits", "comp_total", "avg_duration",
        "segment", "rfm_score",
    ]]
).withColumn("analysis_date", current_date())

(rfm_spark.write.mode("overwrite")
    .option("mergeSchema", "true")
    .saveAsTable("gold.gld_player_rfm_segments"))

churn_spark = spark.createDataFrame(
    df_churn[["player_id", "segment", "rfm_score", "is_churned"]]
).withColumn("analysis_date", current_date())

(churn_spark.write.mode("overwrite")
    .option("mergeSchema", "true")
    .saveAsTable("gold.gld_player_churn_predictions"))

print("Outputs:")
print("  gold.gld_player_rfm_segments")
print("  gold.gld_player_churn_predictions")
print("  MLflow experiment: /Casino/player_value_analysis")
`;

// Floor optimization notebook cells.
const FLR_INTRO_MD = `# Casino Floor Optimization

ML-driven floor optimization and slot performance analytics:

- Machine performance ranking (RTP, occupancy, revenue)
- Floor zone revenue density analysis
- Denomination mix optimization
- KMeans clustering of machines by performance profile
- Peak-hour staffing demand prediction
- Predictive maintenance indicators (error rate + RTP deviation)

> All seed data is **entirely synthetic**.
`;

const FLR_SETUP = `import warnings
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

import mlflow
import mlflow.sklearn
from pyspark.sql.functions import *
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.cluster import KMeans
from sklearn.metrics import mean_absolute_error, r2_score, silhouette_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

warnings.filterwarnings("ignore")
plt.style.use("seaborn-v0_8")
mlflow.set_experiment("/Casino/floor_optimization")
`;

const FLR_LOAD = `# Load slot events + sessions from the silver layer.

def load_floor_data():
    slots = spark.table("silver.slv_slot_events").toPandas()
    sessions = spark.table("silver.slv_player_sessions").toPandas()
    slots["event_timestamp"] = pd.to_datetime(slots["event_timestamp"])
    sessions["session_date"] = pd.to_datetime(sessions["session_date"])
    print(f"Slot events: {len(slots):,}")
    print(f"Sessions:    {len(sessions):,}")
    return slots, sessions


df_slots, df_sessions = load_floor_data()
`;

const FLR_PERF = `# Machine performance ranking — RTP, revenue, jackpot count by machine.

def analyze_machine_performance(slots):
    spins = slots[slots["event_type"] == "SPIN"].copy()
    machine_perf = (
        spins.groupby("machine_id")
        .agg(
            total_spins=("event_id", "count"),
            total_wagered=("credits_wagered", "sum"),
            total_won=("credits_won", "sum"),
            avg_denomination=("denomination", "mean"),
            floor_zone=("floor_zone", lambda x: x.mode().iloc[0] if len(x.mode()) > 0 else "UNKNOWN"),
            jackpot_count=("credits_won", lambda x: (x > 1000).sum()),
        )
        .reset_index()
    )
    machine_perf["actual_rtp"] = (
        machine_perf["total_won"] / machine_perf["total_wagered"].clip(lower=1) * 100
    ).round(2)
    machine_perf["revenue"] = machine_perf["total_wagered"] - machine_perf["total_won"]

    errors = (slots[slots["event_type"] == "ERROR"]
              .groupby("machine_id").size().reset_index(name="error_events"))
    machine_perf = machine_perf.merge(errors, on="machine_id", how="left").fillna(0)
    return machine_perf


machine_perf = analyze_machine_performance(df_slots)
print(machine_perf.head())
`;

const FLR_REV_MODEL = `# Revenue prediction model — GBM regressor; features: spins, wagered,
# denomination, zone, jackpot count.

def predict_machine_revenue(machine_perf):
    le_zone = LabelEncoder()
    machine_perf["zone_encoded"] = le_zone.fit_transform(machine_perf["floor_zone"])

    features = ["total_spins", "total_wagered", "avg_denomination",
                "zone_encoded", "jackpot_count"]
    X = machine_perf[features].fillna(0)
    y = machine_perf["revenue"]

    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)
    scaler = StandardScaler()
    X_tr_s = scaler.fit_transform(X_tr)
    X_te_s = scaler.transform(X_te)

    model = GradientBoostingRegressor(n_estimators=100, max_depth=4, random_state=42)
    with mlflow.start_run(run_name="floor_revenue_prediction"):
        model.fit(X_tr_s, y_tr)
        y_pred = model.predict(X_te_s)
        mae = mean_absolute_error(y_te, y_pred)
        r2  = r2_score(y_te, y_pred)
        mlflow.log_metric("mae", mae)
        mlflow.log_metric("r2",  r2)
        mlflow.sklearn.log_model(model, "floor_revenue_model")
        print(f"Revenue Prediction: MAE={mae:.2f}, R2={r2:.4f}")
    return model, r2


rev_model, rev_r2 = predict_machine_revenue(machine_perf)
`;

const FLR_CLUSTER = `# Cluster machines by performance profile to identify optimization groups.

def cluster_slot_machines(machine_perf):
    cluster_features = ["total_spins", "actual_rtp", "revenue",
                        "avg_denomination", "jackpot_count", "error_events"]
    X = machine_perf[cluster_features].fillna(0)
    X_scaled = StandardScaler().fit_transform(X)

    sil = []
    for k in range(2, 9):
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        sil.append(silhouette_score(X_scaled, km.fit_predict(X_scaled)))
    optimal_k = list(range(2, 9))[int(np.argmax(sil))]
    print(f"Optimal k by silhouette: {optimal_k}")

    km_final = KMeans(n_clusters=optimal_k, random_state=42, n_init=10)
    machine_perf["cluster"] = km_final.fit_predict(X_scaled)
    summary = (machine_perf.groupby("cluster")
        .agg(n_machines=("machine_id", "count"),
             avg_rtp=("actual_rtp", "mean"),
             avg_revenue=("revenue", "mean"),
             total_revenue=("revenue", "sum")).round(2))
    print(summary)
    return machine_perf, summary


machine_perf, cluster_summary = cluster_slot_machines(machine_perf)
`;

const FLR_SAVE = `# Persist outputs to the Gold layer + MLflow.

machine_spark = spark.createDataFrame(
    machine_perf[[
        "machine_id", "total_spins", "total_wagered", "total_won",
        "actual_rtp", "revenue", "floor_zone", "avg_denomination",
        "jackpot_count", "error_events", "cluster",
    ]]
).withColumn("analysis_date", current_date())

(machine_spark.write.mode("overwrite")
    .option("mergeSchema", "true")
    .saveAsTable("gold.gld_machine_performance"))

print("Outputs:")
print("  gold.gld_machine_performance")
print("  MLflow experiment: /Casino/floor_optimization")
`;

// ─── Synthetic seed rows ────────────────────────────────────────────────
// Inserted after the DDL by the warehouse provisioner so the warehouse is
// data-bearing on first open. Five players, five tables/machines, three
// gaming days, five rated sessions, and six handle events — enough for every
// starter query (VIP, hold-by-zone, CTR pre-alert, churn, floor performance)
// and the silver/gold dbt views to return non-empty result sets.
// ALL DATA IS ENTIRELY SYNTHETIC — no real player or financial data.

const WAREHOUSE_SAMPLE_ROWS: { table: string; columns?: string[]; rows: any[][] }[] = [
  {
    table: 'casino.dim_player',
    columns: [
      'player_sk', 'player_id', 'player_first_name', 'player_last_name',
      'enrollment_date', 'tier', 'home_state', 'date_of_birth',
      'self_excluded', 'do_not_market', 'lifetime_adt', 'last_visit_date',
      'is_current', 'valid_from',
    ],
    rows: [
      [1, 'P100001', 'Avery',  'Nguyen',   '2019-03-14', 'DIAMOND',  'NV', '1971-07-02', 0, 0, 2150.00, '2026-05-30', 1, '2019-03-14T00:00:00'],
      [2, 'P100002', 'Jordan', 'Whitfield','2020-08-01', 'PLATINUM', 'CA', '1980-11-21', 0, 0,  620.00, '2026-05-28', 1, '2020-08-01T00:00:00'],
      [3, 'P100003', 'Riley',  'Okafor',   '2021-01-19', 'GOLD',     'AZ', '1965-02-09', 0, 0,  205.00, '2026-04-12', 1, '2021-01-19T00:00:00'],
      [4, 'P100004', 'Sasha',  'Delgado',  '2022-06-30', 'SILVER',   'OR', '1990-09-15', 0, 0,   72.00, '2026-03-02', 1, '2022-06-30T00:00:00'],
      [5, 'P100005', 'Morgan', 'Bauer',    '2018-12-05', 'BRONZE',   'WA', '1958-04-27', 0, 0,   18.00, '2025-12-20', 1, '2018-12-05T00:00:00'],
    ],
  },
  {
    table: 'casino.dim_table',
    columns: [
      'table_sk', 'table_id', 'table_type', 'game_theme', 'denomination',
      'floor_zone', 'min_bet', 'max_bet', 'target_hold_pct',
      'par_sheet_rtp_pct', 'install_date', 'is_active',
    ],
    rows: [
      [1, 'SLT-0001', 'SLOT',      'Buffalo Gold',   1.00, 'A1',  1.00,  500.00, 8.00, 92.50, '2023-02-01', 1],
      [2, 'SLT-0002', 'SLOT',      'Lightning Link', 0.25, 'A2',  0.25,  250.00, 9.00, 91.00, '2023-02-01', 1],
      [3, 'BJ-0007',  'BLACKJACK', 'Classic 21',     5.00, 'VIP', 25.00, 5000.00, 6.00, 99.50, '2022-11-15', 1],
      [4, 'SLT-0034', 'SLOT',      'Dragon Cash',    0.50, 'B1',  0.50,  300.00, 8.50, 92.00, '2024-01-20', 1],
      [5, 'ROU-0003', 'ROULETTE',  'Double Zero',    1.00, 'C1',  5.00, 10000.00, 5.26, 94.74, '2021-09-10', 1],
    ],
  },
  {
    table: 'casino.dim_date',
    columns: [
      'date_sk', 'full_date', 'day_of_week', 'day_name', 'is_weekend',
      'week_of_year', 'month_num', 'month_name', 'quarter_num', 'year_num',
      'gaming_day_start',
    ],
    rows: [
      [20260530, '2026-05-30', 7, 'Saturday', 1, 22, 5, 'May', 2, 2026, '2026-05-30T06:00:00'],
      [20260529, '2026-05-29', 6, 'Friday',   1, 22, 5, 'May', 2, 2026, '2026-05-29T06:00:00'],
      [20260528, '2026-05-28', 5, 'Thursday', 0, 22, 5, 'May', 2, 2026, '2026-05-28T06:00:00'],
    ],
  },
  {
    table: 'casino.fact_session',
    columns: [
      'session_sk', 'session_id', 'player_sk', 'table_sk', 'date_sk',
      'session_start', 'session_end', 'duration_minutes', 'game_type',
      'coin_in', 'coin_out', 'theoretical_win', 'actual_win', 'avg_bet',
      'rated_play', 'comp_value', 'session_rating', 'floor_zone', 'ingest_ts',
    ],
    rows: [
      [1, 'S2026053000001', 1, 3, 20260530, '2026-05-30T20:15:00', '2026-05-30T23:40:00', 205, 'BLACKJACK', 84000.00, 31000.00, 5040.00, 53000.00, 250.00, 1, 1200.00, 5, 'VIP', '2026-05-31T06:05:00'],
      [2, 'S2026053000002', 2, 1, 20260530, '2026-05-30T18:30:00', '2026-05-30T20:05:00',  95, 'SLOT',      12500.00,  9800.00,  1000.00,  2700.00,   5.00, 1,  150.00, 4, 'A1',  '2026-05-31T06:05:00'],
      [3, 'S2026052900001', 3, 4, 20260529, '2026-05-29T13:10:00', '2026-05-29T15:00:00', 110, 'SLOT',       3400.00,  3050.00,   289.00,   350.00,   2.50, 1,   40.00, 3, 'B1',  '2026-05-30T06:05:00'],
      [4, 'S2026052900002', 4, 2, 20260529, '2026-05-29T11:00:00', '2026-05-29T11:45:00',  45, 'SLOT',        900.00,   840.00,    81.00,    60.00,   1.25, 1,   10.00, 2, 'A2',  '2026-05-30T06:05:00'],
      [5, 'S2026052800001', 5, 5, 20260528, '2026-05-28T22:05:00', '2026-05-28T22:35:00',  30, 'ROULETTE',     600.00,   570.00,    31.56,    30.00,  20.00, 1,    5.00, 1, 'C1',  '2026-05-29T06:05:00'],
    ],
  },
  {
    table: 'casino.fact_handle',
    columns: [
      'handle_sk', 'event_id', 'session_sk', 'player_sk', 'table_sk',
      'date_sk', 'event_ts', 'event_type', 'denomination', 'credits_wagered',
      'credits_won', 'jackpot_amount', 'hand_pay_amount', 'rtp_contribution',
      'floor_zone', 'ctr_trigger', 'ingest_ts',
    ],
    rows: [
      [1, 'E20260530A0001', 2, 2, 1, 20260530, '2026-05-30T18:31:12', 'SPIN',     1.00,  500,    0, null,     null, 0.9100, 'A1',  0, '2026-05-31T06:05:00'],
      [2, 'E20260530A0002', 2, 2, 1, 20260530, '2026-05-30T18:42:55', 'JACKPOT',  1.00,  500, 2500, 2500.00,  null, 0.9100, 'A1',  0, '2026-05-31T06:05:00'],
      [3, 'E20260530V0001', 1, 1, 3, 20260530, '2026-05-30T21:05:00', 'CASH_IN',  1.00, 12000,   0, null,     null, null,   'VIP', 1, '2026-05-31T06:05:00'],
      [4, 'E20260530V0002', 1, 1, 3, 20260530, '2026-05-30T22:50:00', 'HAND_PAY', 1.00,     0, 9000, null,  9000.00, null,   'VIP', 0, '2026-05-31T06:05:00'],
      [5, 'E20260529B0001', 3, 3, 4, 20260529, '2026-05-29T13:15:30', 'SPIN',     0.50,  100,   80, null,     null, 0.9200, 'B1',  0, '2026-05-30T06:05:00'],
      [6, 'E20260528C0001', 5, 5, 5, 20260528, '2026-05-28T22:10:00', 'SPIN',     1.00,   20,    0, null,     null, 0.9474, 'C1',  0, '2026-05-29T06:05:00'],
    ],
  },
];

// ─── Bundle ─────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-casino-analytics',
  intro:
    'Reference architecture for tribal-casino operations analytics: ' +
    'player-grain warehouse (sessions + handles), high-roller Activator ' +
    'alerts wired to Teams, and Databricks notebooks for RFM/LTV/churn ' +
    'modeling and floor optimization. Compliance-aware: NIGC MICS, Title 31 ' +
    'CTR/SAR detection patterns. All seed data is synthetic.',
  sourceDocs: [
    'examples/casino-analytics/README.md',
    'examples/casino-analytics/notebooks/player_value_analysis.py',
    'examples/casino-analytics/notebooks/floor_optimization.py',
    'examples/casino-analytics/domains/dbt/dbt_project.yml',
    'examples/casino-analytics/domains/dbt/models/bronze/brz_slot_events.sql',
    'examples/casino-analytics/domains/dbt/models/silver/slv_player_sessions.sql',
    'examples/casino-analytics/domains/dbt/models/silver/slv_slot_performance.sql',
    'examples/casino-analytics/domains/dbt/models/gold/gld_player_value.sql',
    'examples/casino-analytics/domains/dbt/models/gold/gld_floor_optimization.sql',
    'examples/casino-analytics/streaming/kql_queries.kql',
    'examples/casino-analytics/contracts/player-analytics.yaml',
  ],
  items: [
    {
      itemType: 'warehouse',
      displayName: 'Casino Data Warehouse',
      description:
        'Player-grain star schema: dim_player (SCD2), dim_table, dim_date, ' +
        'fact_session, fact_handle. Hold-percentage variance, RTP, and ' +
        'Title 31 CTR triggers are first-class columns.',
      learnDoc: 'casino-analytics/warehouse',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        dbtProject: DBT_PROJECT_YML,
        dbtModels: [
          { layer: 'bronze', name: 'brz_slot_events',       sql: DBT_BRZ_SLOT_EVENTS },
          { layer: 'silver', name: 'slv_player_sessions',   sql: DBT_SLV_PLAYER_SESSIONS },
          { layer: 'silver', name: 'slv_slot_performance',  sql: DBT_SLV_SLOT_PERFORMANCE },
          { layer: 'gold',   name: 'gld_player_value',      sql: DBT_GLD_PLAYER_VALUE },
          { layer: 'gold',   name: 'gld_floor_optimization', sql: DBT_GLD_FLOOR_OPTIMIZATION },
        ],
        starterQueries: [
          { name: 'Top 50 VIPs by 90-day theoretical win', sql: STARTER_QUERY_VIP },
          { name: 'Hold percentage variance by zone (last 30 days)', sql: STARTER_QUERY_HOLD_BY_ZONE },
          { name: 'Title 31 CTR pre-alert (8K-10K cash activity)', sql: STARTER_QUERY_CTR },
          { name: 'Churn-risk players for win-back campaign', sql: STARTER_QUERY_CHURN },
          { name: 'Daily floor performance by zone with hold variance flag', sql: STARTER_QUERY_FLOOR_PERF },
        ],
        // Synthetic seed so the warehouse lands 'seeded' (not empty) the moment
        // the install finishes: the starter queries + dbt views over these base
        // tables return real result sets. Inserted by the warehouse provisioner
        // (seedSampleRows → multi-row INSERT + SELECT COUNT(*) verify) over the
        // same Synapse TDS target the DDL ran on. Column lists are explicit so
        // the computed/STORED columns (net_result, coin_in_amount, coin_out_amount)
        // are left for the engine and the FK order (players → tables → dates →
        // sessions → handles) is respected by the array order below.
        // ALL VALUES ARE ENTIRELY SYNTHETIC — no real player data.
        sampleRows: WAREHOUSE_SAMPLE_ROWS,
      },
    },
    {
      itemType: 'activator',
      displayName: 'High-Roller Alert',
      description:
        'Posts a Microsoft Teams message to the floor-manager channel when ' +
        'a player\'s net win in the last hour exceeds $50,000 — host can ' +
        'respond with comps or, for Title 31 / W-2G amounts, route to the ' +
        'compliance officer.',
      learnDoc: 'casino-analytics/high-roller-alert',
      content: {
        kind: 'activator',
        rule: {
          name: 'High-Roller Net-Win Alert ($50K / 1h)',
          condition: {
            metric: 'fact_handle.coin_out_amount - fact_handle.coin_in_amount',
            op: '>',
            threshold: 50000,
          },
          window: 'PT1H',
          action: {
            kind: 'teams',
            config: {
              channel: 'Floor Operations',
              channelId: '19:floor-operations@thread.tacv2',
              webhookSecretName: 'TEAMS_FLOOR_OPS_WEBHOOK',
              messageTemplate:
                'High-roller alert: player {{player_id}} ({{tier}}) is up ' +
                '${{net_win | format_currency}} in the last hour on ' +
                'machine {{machine_id}} ({{floor_zone}}). ' +
                'Visit history: {{visits_per_month}} visits/mo, lifetime ADT ${{lifetime_adt}}. ' +
                'Recommended action: dispatch host with VIP comp bundle. ' +
                'If amount >= $10K cash, also notify Compliance.',
              mentions: ['@floor-manager-on-shift'],
              actionButtons: [
                { title: 'Open Player 360', url: '/casino/players/{{player_id}}' },
                { title: 'Issue Comp',      url: '/casino/comps/new?player={{player_id}}&amount=500' },
                { title: 'Title 31 review', url: '/casino/compliance/ctr?player={{player_id}}' },
              ],
              priority: 'high',
            },
          },
        },
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Player Value Analysis',
      description:
        'Databricks notebook: RFM segmentation, churn prediction (LogReg / ' +
        'RandomForest / GBM ensemble), LTV forecasting, and promotional-ROI ' +
        'analysis. Writes outputs to gold.gld_player_rfm_segments + MLflow.',
      learnDoc: 'casino-analytics/player-value-notebook',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          cell('markdown', PVA_INTRO_MD),
          cell('markdown', '## Setup'),
          cell('code', PVA_SETUP),
          cell('markdown', '## Data Loading'),
          cell('code', PVA_LOAD),
          cell('markdown', '## RFM Analysis'),
          cell('code', PVA_RFM),
          cell('markdown', '## Churn Prediction Model'),
          cell('code', PVA_CHURN),
          cell('markdown', '## Save Results'),
          cell('code', PVA_SAVE),
        ],
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Floor Optimization',
      description:
        'Databricks notebook: machine performance ranking, GBM revenue ' +
        'prediction, KMeans clustering of machines by performance profile, ' +
        'and gold-layer outputs for the floor-operations dashboard.',
      learnDoc: 'casino-analytics/floor-optimization-notebook',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          cell('markdown', FLR_INTRO_MD),
          cell('markdown', '## Setup'),
          cell('code', FLR_SETUP),
          cell('markdown', '## Data Loading'),
          cell('code', FLR_LOAD),
          cell('markdown', '## Machine Performance Analysis'),
          cell('code', FLR_PERF),
          cell('markdown', '## Revenue Prediction Model'),
          cell('code', FLR_REV_MODEL),
          cell('markdown', '## Slot Machine Clustering'),
          cell('code', FLR_CLUSTER),
          cell('markdown', '## Save Results'),
          cell('code', FLR_SAVE),
        ],
      },
    },
  ],
};

export default bundle;
