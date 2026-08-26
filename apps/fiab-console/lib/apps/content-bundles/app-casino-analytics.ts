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
 *
 * #4093 — the two notebooks originally carried the upstream Databricks source
 * verbatim, so their cells read `silver.slv_slot_events` /
 * `silver.slv_fnb_transactions`: tables this bundle NEVER creates. They opened
 * looking authoritative and failed on the first Run. The cells are now written
 * against the star schema the bundle actually provisions and seeds
 * (casino.dim_player / dim_table / dim_date / fact_session / fact_handle),
 * read from the Synapse dedicated SQL pool with `spark.read.synapsesql`.
 *
 * The seed is deliberately small (24 rows), so every analysis degrades
 * gracefully at that scale rather than throwing or emitting a hollow result:
 * RFM uses rank percentiles instead of `pd.qcut` (which raises on tied/small
 * samples), the KMeans k sweep is bounded by the machine count, and each model
 * prints the row count and whether its metrics are hold-out or in-sample.
 */

import type { AppBundle } from './types';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import { backendUtilShimCell } from './notebook-backend';

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

// Authored in Azure Synapse **dedicated SQL pool** T-SQL (the backend the live
// console targets when LOOM_WAREHOUSE_BACKEND is unset → 'synapse-dedicated').
// Dedicated pool grammar differs from Databricks/Fabric Lakehouse SQL, so this
// DDL deliberately avoids every dedicated-pool-unsupported feature (confirmed
// against Microsoft Learn — develop-tables-overview#unsupported-table-features
// and sql-data-warehouse-table-constraints):
//   • NO `CREATE SCHEMA IF NOT EXISTS` — grammar is `CREATE SCHEMA name [;]`.
//     Idempotency comes from an sys.schemas guard + EXEC (dynamic SQL).
//   • NO `CREATE TABLE IF NOT EXISTS` — guarded with `IF OBJECT_ID(...) IS NULL`.
//   • NO FOREIGN KEY / CHECK constraints (unsupported). Referential integrity
//     is enforced upstream (dbt tests + the load pipeline); PKs are declared
//     NONCLUSTERED NOT ENFORCED, the only PK form the pool accepts.
//   • NO computed/`GENERATED ALWAYS AS … STORED` columns (unsupported). The
//     former computed columns (net_result, coin_in_amount, coin_out_amount)
//     are now persisted columns populated by the load/seed (value = the same
//     expression) so the starter queries and dbt views that read them work
//     unchanged.
//   • NO `CREATE INDEX … IF NOT EXISTS`, filtered (`WHERE`) indexes, or
//     `PARTITION BY RANGE` — facts use a clustered columnstore index + hash
//     distribution; fact_handle is range-PARTITIONed in the WITH() clause on
//     date_sk; dims are REPLICATEd (small).
// Each statement is its own batch (split on `;\n` by the warehouse provisioner).
const WAREHOUSE_DDL = `-- ════════════════════════════════════════════════════════════════════
-- Casino Analytics Data Warehouse  (Azure Synapse dedicated SQL pool)
-- Star schema: player-grain facts (sessions, individual hands/spins) with
-- supporting dimensions for players, tables/machines, dates, and zones.
-- Compliance: NIGC MICS, Title 31 BSA/AML. All seed data is synthetic.
-- ════════════════════════════════════════════════════════════════════

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'casino') EXEC('CREATE SCHEMA casino');

-- ─── Dimensions (small → REPLICATE) ─────────────────────────────────────

IF OBJECT_ID('casino.dim_player', 'U') IS NULL
CREATE TABLE casino.dim_player (
    player_sk           BIGINT          NOT NULL,
    player_id           VARCHAR(64)     NOT NULL,
    player_first_name   VARCHAR(80)     NULL,
    player_last_name    VARCHAR(80)     NULL,
    enrollment_date     DATE            NULL,
    tier                VARCHAR(16)     NOT NULL,     -- BRONZE|SILVER|GOLD|PLATINUM|DIAMOND
    tier_qualified_at   DATETIME2       NULL,
    home_state          CHAR(2)         NULL,
    date_of_birth       DATE            NULL,
    self_excluded       BIT             NOT NULL,
    do_not_market       BIT             NOT NULL,
    lifetime_adt        DECIMAL(12, 2)  NULL,
    last_visit_date     DATE            NULL,
    is_current          BIT             NOT NULL,
    valid_from          DATETIME2       NOT NULL,
    valid_to            DATETIME2       NULL,
    CONSTRAINT pk_dim_player PRIMARY KEY NONCLUSTERED (player_sk) NOT ENFORCED
)
WITH (DISTRIBUTION = REPLICATE, CLUSTERED COLUMNSTORE INDEX);

IF OBJECT_ID('casino.dim_table', 'U') IS NULL
CREATE TABLE casino.dim_table (
    table_sk            BIGINT          NOT NULL,
    table_id            VARCHAR(32)     NOT NULL,
    table_type          VARCHAR(32)     NOT NULL,     -- SLOT, BLACKJACK, POKER, ROULETTE, BACCARAT, CRAPS
    game_theme          VARCHAR(80)     NULL,
    denomination        DECIMAL(6, 2)   NULL,
    floor_zone          VARCHAR(8)      NOT NULL,      -- A1|A2|B1|B2|C1|C2|D1|VIP
    min_bet             DECIMAL(8, 2)   NULL,
    max_bet             DECIMAL(10, 2)  NULL,
    target_hold_pct     DECIMAL(5, 2)   NOT NULL,
    par_sheet_rtp_pct   DECIMAL(5, 2)   NULL,
    install_date        DATE            NULL,
    last_service_date   DATE            NULL,
    is_active           BIT             NOT NULL,
    CONSTRAINT pk_dim_table PRIMARY KEY NONCLUSTERED (table_sk) NOT ENFORCED
)
WITH (DISTRIBUTION = REPLICATE, CLUSTERED COLUMNSTORE INDEX);

IF OBJECT_ID('casino.dim_date', 'U') IS NULL
CREATE TABLE casino.dim_date (
    date_sk             INT             NOT NULL,      -- yyyymmdd
    full_date           DATE            NOT NULL,
    day_of_week         TINYINT         NOT NULL,
    day_name            VARCHAR(10)     NOT NULL,
    is_weekend          BIT             NOT NULL,
    is_holiday          BIT             NOT NULL,
    holiday_name        VARCHAR(64)     NULL,
    week_of_year        TINYINT         NOT NULL,
    month_num           TINYINT         NOT NULL,
    month_name          VARCHAR(10)     NOT NULL,
    quarter_num         TINYINT         NOT NULL,
    year_num            SMALLINT        NOT NULL,
    fiscal_period       VARCHAR(8)      NULL,
    gaming_day_start    DATETIME2       NOT NULL,      -- 06:00 local
    CONSTRAINT pk_dim_date PRIMARY KEY NONCLUSTERED (date_sk) NOT ENFORCED
)
WITH (DISTRIBUTION = REPLICATE, CLUSTERED COLUMNSTORE INDEX);

-- ─── Facts (large → HASH distribute on player_sk; CCI) ──────────────────

IF OBJECT_ID('casino.fact_session', 'U') IS NULL
CREATE TABLE casino.fact_session (
    session_sk          BIGINT          NOT NULL,
    session_id          VARCHAR(64)     NOT NULL,
    player_sk           BIGINT          NOT NULL,
    table_sk            BIGINT          NOT NULL,
    date_sk             INT             NOT NULL,
    session_start       DATETIME2       NOT NULL,
    session_end         DATETIME2       NULL,
    duration_minutes    INT             NULL,
    game_type           VARCHAR(32)     NOT NULL,
    coin_in             DECIMAL(14, 2)  NOT NULL,
    coin_out            DECIMAL(14, 2)  NOT NULL,
    theoretical_win     DECIMAL(14, 2)  NOT NULL,
    actual_win          DECIMAL(14, 2)  NOT NULL,
    net_result          DECIMAL(14, 2)  NOT NULL,      -- persisted (= coin_in - coin_out); maintained at load
    avg_bet             DECIMAL(8, 2)   NULL,
    rated_play          BIT             NOT NULL,
    comp_value          DECIMAL(10, 2)  NULL,
    session_rating      TINYINT         NULL,          -- 1-5
    floor_zone          VARCHAR(8)      NOT NULL,
    ingest_ts           DATETIME2       NOT NULL,
    CONSTRAINT pk_fact_session PRIMARY KEY NONCLUSTERED (session_sk) NOT ENFORCED
)
WITH (DISTRIBUTION = HASH(player_sk), CLUSTERED COLUMNSTORE INDEX);

-- Grain: one row per individual handle event (slot spin, table hand, jackpot,
-- bonus, cash-in, cash-out). Volume ~50M/day → HASH distribute on table_sk and
-- range-PARTITION on date_sk (gaming-day boundaries) for partition elimination.
IF OBJECT_ID('casino.fact_handle', 'U') IS NULL
CREATE TABLE casino.fact_handle (
    handle_sk           BIGINT          NOT NULL,
    event_id            VARCHAR(64)     NOT NULL,
    session_sk          BIGINT          NULL,          -- NULL for unrated play
    player_sk           BIGINT          NULL,
    table_sk            BIGINT          NOT NULL,
    date_sk             INT             NOT NULL,
    event_ts            DATETIME2       NOT NULL,
    event_type          VARCHAR(16)     NOT NULL,      -- SPIN, JACKPOT, BONUS, CASH_IN, CASH_OUT, HAND_PAY, TILT, DOOR_OPEN
    denomination        DECIMAL(6, 2)   NOT NULL,
    credits_wagered     INT             NULL,
    credits_won         INT             NULL,
    coin_in_amount      DECIMAL(12, 2)  NULL,          -- persisted (= credits_wagered * denomination); maintained at load
    coin_out_amount     DECIMAL(12, 2)  NULL,          -- persisted (= credits_won * denomination); maintained at load
    jackpot_amount      DECIMAL(12, 2)  NULL,
    hand_pay_amount     DECIMAL(12, 2)  NULL,
    progressive_pool_id VARCHAR(32)     NULL,
    rtp_contribution    DECIMAL(8, 4)   NULL,
    floor_zone          VARCHAR(8)      NOT NULL,
    ctr_trigger         BIT             NOT NULL,       -- Title 31 $10K event
    tilt_code           VARCHAR(16)     NULL,
    ingest_ts           DATETIME2       NOT NULL,
    CONSTRAINT pk_fact_handle PRIMARY KEY NONCLUSTERED (handle_sk, date_sk) NOT ENFORCED
)
WITH (
    DISTRIBUTION = HASH(table_sk),
    CLUSTERED COLUMNSTORE INDEX,
    PARTITION (date_sk RANGE RIGHT FOR VALUES
        (20260101, 20260201, 20260301, 20260401, 20260501, 20260601))
);
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

// Starter analyst queries — authored in Azure Synapse dedicated SQL pool
// T-SQL (TOP not LIMIT; CAST(GETDATE() AS DATE) not CURRENT_DATE) so they run
// as-is against the provisioned warehouse over the seeded star schema.
const STARTER_QUERY_VIP = `-- Top-50 VIPs in the last 90 days by theoretical win.
-- Used by player development hosts to prioritize outreach.
SELECT TOP (50)
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
WHERE d.full_date >= DATEADD(day, -90, CAST(GETDATE() AS DATE))
  AND p.self_excluded = 0
GROUP BY p.player_id, p.player_last_name, p.tier
ORDER BY theo_win_90d DESC;
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
WHERE d.full_date >= DATEADD(day, -30, CAST(GETDATE() AS DATE))
  AND h.event_type = 'SPIN'
GROUP BY t.floor_zone
ORDER BY ABS(
          100.0 *
          (SUM(h.coin_in_amount) - SUM(h.coin_out_amount)) /
          NULLIF(SUM(h.coin_in_amount), 0)
          - AVG(t.target_hold_pct)) DESC;
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
WHERE h.event_ts >= DATEADD(hour, -24, SYSDATETIME())
  AND h.event_type IN ('CASH_IN', 'CASH_OUT', 'HAND_PAY')
  AND p.player_sk IS NOT NULL
GROUP BY p.player_id, p.player_last_name, p.tier
HAVING SUM(CASE WHEN h.event_type = 'CASH_IN'  THEN h.coin_in_amount  ELSE 0 END) +
       SUM(CASE WHEN h.event_type = 'HAND_PAY' THEN h.hand_pay_amount ELSE 0 END) >= 8000
ORDER BY (cash_in_total + hand_pay_total) DESC;
`;

const STARTER_QUERY_CHURN = `-- Churn-risk players (no visit in 30+ days) sorted by historical ADT.
-- Drives a "win-back" mail/email campaign from marketing.
SELECT TOP (200)
    p.player_id,
    p.player_last_name,
    p.tier,
    p.last_visit_date,
    DATEDIFF(day, p.last_visit_date, CAST(GETDATE() AS DATE))  AS days_since_last_visit,
    p.lifetime_adt,
    COUNT(DISTINCT s.session_id)                    AS sessions_lifetime,
    ROUND(SUM(s.theoretical_win), 2)                AS lifetime_theoretical
FROM casino.dim_player    p
LEFT JOIN casino.fact_session s ON s.player_sk = p.player_sk
WHERE p.self_excluded = 0
  AND p.do_not_market = 0
  AND DATEDIFF(day, p.last_visit_date, CAST(GETDATE() AS DATE)) BETWEEN 30 AND 120
  AND p.lifetime_adt >= 50
GROUP BY p.player_id, p.player_last_name, p.tier, p.last_visit_date, p.lifetime_adt
ORDER BY p.lifetime_adt DESC, days_since_last_visit ASC;
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
WHERE d.full_date >= DATEADD(day, -7, CAST(GETDATE() AS DATE))
GROUP BY d.full_date, t.floor_zone
ORDER BY d.full_date DESC,
         ABS(100.0 * (SUM(s.coin_in) - SUM(s.coin_out)) / NULLIF(SUM(s.coin_in), 0)
             - AVG(t.target_hold_pct)) DESC;
`;

// ─── Notebook cells ─────────────────────────────────────────────────────
// Source: examples/casino-analytics/notebooks/player_value_analysis.py
// Split into logical cells along the original `# COMMAND ----------` markers.

const PVA_INTRO_MD = `# Player Value Analysis

Player analytics over the **casino star schema this app installs** — no silver
layer to build first, no Microsoft Fabric, no external dataset.

| Source table | Grain |
|---|---|
| casino.dim_player | one row per player (SCD2, current) |
| casino.dim_table | one row per machine / table game |
| casino.dim_date | one row per gaming day |
| casino.fact_session | one row per rated play session |
| casino.fact_handle | one row per handle event (spin, jackpot, cash-in, hand-pay) |

What the cells below produce:

- **RFM scoring and segmentation** — VIP / Loyal / Regular / New / At Risk / Lost
- **Churn-risk scorecard** — risk band, 0-100 risk score, value at risk
- **Comp efficiency and ADT** per player, plus annualised LTV when the observed
  window is long enough to project one honestly
- **A churn classifier** (LogReg / RandomForest / GBM) whose validation basis is
  chosen by the sample size and printed with the row count, so an in-sample fit
  is never mistaken for a generalisation estimate

The warehouse is an Azure Synapse **dedicated SQL pool**, so its tables are not
in the Spark metastore. Cells read them with the Azure Synapse Dedicated SQL
Pool Connector for Apache Spark (spark.read.synapsesql) — a default library in
every Synapse workspace, authenticated with Microsoft Entra ID pass-through.

> All seed data is **entirely synthetic** — no real player data is included.
`;

// Shared preface for BOTH notebooks: resolve the dedicated SQL pool, define the
// warehouse reader, and define the best-effort MLflow logger. Authored once and
// concatenated INTO each notebook's setup cell — a notebook cannot import from a
// sibling notebook, so this is inlined rather than referenced.
const NB_WAREHOUSE_PREFACE = `# The Casino Data Warehouse this app installs is an Azure Synapse DEDICATED SQL
# pool (T-SQL), not a Spark database, so its tables are NOT visible to
# spark.table(). They are read with the Azure Synapse Dedicated SQL Pool
# Connector for Apache Spark:
#     spark.read.synapsesql("<pool>.<schema>.<table>")
# which ships as a default library in every Synapse workspace and authenticates
# with Microsoft Entra ID credential pass-through - no connection string, no
# secret, no Fabric.
# https://learn.microsoft.com/azure/synapse-analytics/spark/synapse-spark-sql-pool-import-export
import os
from decimal import Decimal

import numpy as np
import pandas as pd

if "loom_get_arg" not in globals():   # backend-util shim cell not run yet
    def loom_get_arg(name, default=None):
        return os.environ.get(name.upper(), default)

# Loom substitutes the pool name at install time from LOOM_SYNAPSE_DEDICATED_POOL.
# A notebook parameter or a spark.conf value wins, so the same notebook can be
# pointed at a different pool without editing it.
WAREHOUSE_DB = (
    loom_get_arg("warehouse_db")
    or spark.conf.get("spark.loom.warehouseDb", "")
    or "{{SYNAPSE_DEDICATED_POOL}}"
)
WAREHOUSE_SCHEMA = "casino"

if not WAREHOUSE_DB or "{{" in WAREHOUSE_DB:
    raise RuntimeError(
        "The dedicated SQL pool name did not resolve (got %r). Loom fills this "
        "in at install time from LOOM_SYNAPSE_DEDICATED_POOL; to override, pass "
        "the notebook parameter warehouse_db or set spark.loom.warehouseDb."
        % (WAREHOUSE_DB,)
    )


def read_warehouse(table):
    """Read one casino.<table> from the dedicated SQL pool into a pandas frame.

    Raises with what was actually OBSERVED plus the exact grant to apply. Never
    substitutes a fabricated or empty stand-in frame, and treats a zero-row read
    as a finding rather than a pass.
    """
    three_part = "%s.%s.%s" % (WAREHOUSE_DB, WAREHOUSE_SCHEMA, table)
    try:
        pdf = spark.read.synapsesql(three_part).toPandas()
    except Exception as exc:
        raise RuntimeError(
            "Could not read %s. Observed: %s. If that is an authorization "
            "failure, grant the Spark identity read access on the pool - "
            "EXEC sp_addrolemember 'db_exporter', [<spark-identity>]; - run "
            "against the %s database." % (three_part, exc, WAREHOUSE_DB)
        ) from exc
    # DECIMAL columns arrive as Python Decimal objects in an object-dtype column;
    # numpy and scikit-learn cannot do arithmetic on those, so coerce to float.
    for col in pdf.columns:
        if pdf[col].dtype == "object":
            nonnull = pdf[col].dropna()
            if len(nonnull) and isinstance(nonnull.iloc[0], Decimal):
                pdf[col] = pd.to_numeric(pdf[col], errors="coerce")
    if len(pdf) == 0:
        raise RuntimeError(
            "%s returned 0 rows. The app install seeds this table, so an empty "
            "read means the seed step did not run or was rolled back. Reinstall "
            "the Casino Analytics app rather than analysing an empty warehouse."
            % three_part
        )
    print("  %-16s %6d rows" % (table, len(pdf)))
    return pdf


def _mlflow_log(experiment, run_name, metrics):
    """Log metrics to MLflow when the runtime provides one.

    Synapse Spark pools do not ship an MLflow tracking server, so this is
    best-effort BY DESIGN: a missing or unreachable MLflow never breaks the run,
    and the cell says so rather than failing silently.
    """
    try:
        import mlflow
    except ImportError:
        return False
    try:
        mlflow.set_experiment(experiment)
        with mlflow.start_run(run_name=run_name):
            for key, value in metrics.items():
                mlflow.log_metric(key, float(value))
        return True
    except Exception as exc:
        print("  (MLflow logging unavailable: %s)" % exc)
        return False
`;

const PVA_SETUP = `# Setup - resolve the warehouse and define the reader every cell below uses.
${NB_WAREHOUSE_PREFACE}
MLFLOW_EXPERIMENT = "/Casino/player_value_analysis"

print("Warehouse: %s.%s" % (WAREHOUSE_DB, WAREHOUSE_SCHEMA))
`;

const PVA_LOAD = `# Load the star schema and denormalise it onto the grains the analyses need.
print("Loading casino star schema:")
dim_player = read_warehouse("dim_player")
dim_table = read_warehouse("dim_table")
dim_date = read_warehouse("dim_date")
fact_session = read_warehouse("fact_session")
fact_handle = read_warehouse("fact_handle")

dim_player["last_visit_date"] = pd.to_datetime(dim_player["last_visit_date"])
dim_date["full_date"] = pd.to_datetime(dim_date["full_date"])
fact_session["session_start"] = pd.to_datetime(fact_session["session_start"])
fact_handle["event_ts"] = pd.to_datetime(fact_handle["event_ts"])

# Session grain plus the player / table / date attributes the analyses read.
# floor_zone and denomination live on more than one table - take them from the
# fact so the joins stay free of _x/_y suffixes.
sessions = (
    fact_session
    .merge(
        dim_player[["player_sk", "player_id", "player_last_name", "tier",
                    "lifetime_adt", "last_visit_date", "self_excluded",
                    "do_not_market"]],
        on="player_sk", how="left")
    .merge(
        dim_table[["table_sk", "table_id", "table_type", "game_theme",
                   "target_hold_pct"]],
        on="table_sk", how="left")
    .merge(
        dim_date[["date_sk", "full_date", "is_weekend", "day_name"]],
        on="date_sk", how="left")
)

# Handle grain - event-level play, attributed to a player where the play is rated.
handles = fact_handle.merge(
    dim_player[["player_sk", "player_id", "tier"]], on="player_sk", how="left")

print("")
print("Sessions:      %d rows / %d players / %d gaming days"
      % (len(sessions), sessions["player_id"].nunique(),
         sessions["date_sk"].nunique()))
print("Handle events: %d rows / %d event types (%s)"
      % (len(handles), handles["event_type"].nunique(),
         ", ".join(sorted(handles["event_type"].unique()))))
print("Players:       %d across tiers %s"
      % (len(dim_player), ", ".join(sorted(dim_player["tier"].unique()))))
`;

const PVA_RFM = `# RFM - Recency / Frequency / Monetary scoring and segmentation.
#
# Scores are RANK-PERCENTILE based rather than pd.qcut: qcut raises or collapses
# to a single bin on small or heavily tied samples, which is exactly what a
# freshly seeded warehouse looks like. Rank percentiles are well defined at any
# row count, from one player to millions.

RFM_BINS = 5
LTV_MIN_WINDOW_DAYS = 30   # below this an annualised projection is not honest


def rfm_score(series, higher_is_better=True, bins=RFM_BINS):
    """Score a measure into 1..bins by rank percentile. Safe at any sample size."""
    pct = series.rank(pct=True, ascending=higher_is_better, method="average")
    return np.ceil(pct * bins).clip(lower=1, upper=bins).astype(int)


def compute_rfm(sessions, handles, players):
    # As-of date = the day after the latest signal in the warehouse, so recency
    # is measured against the DATA rather than against wall-clock today (which
    # would drift the whole analysis as the seeded warehouse ages).
    as_of = max(sessions["full_date"].max(),
                players["last_visit_date"].max()) + pd.Timedelta(days=1)
    window_days = max((as_of - sessions["full_date"].min()).days, 1)

    gaming = (
        sessions.groupby("player_id")
        .agg(rated_sessions=("session_id", "count"),
             visit_days=("date_sk", "nunique"),
             coin_in=("coin_in", "sum"),
             coin_out=("coin_out", "sum"),
             theoretical_win=("theoretical_win", "sum"),
             actual_win=("actual_win", "sum"),
             comp_value=("comp_value", "sum"),
             avg_bet=("avg_bet", "mean"),
             avg_session_minutes=("duration_minutes", "mean"),
             game_variety=("game_type", "nunique"),
             zones_played=("floor_zone", "nunique"))
        .reset_index()
    )

    # Every tracked handle event evidences depth of play, so it counts toward
    # Frequency alongside the rated session itself.
    events = (
        handles.dropna(subset=["player_id"])
        .groupby("player_id")
        .agg(handle_events=("event_id", "count"),
             jackpots=("jackpot_amount", lambda s: int(s.notna().sum())),
             cash_in_amount=("coin_in_amount", "sum"))
        .reset_index()
    )

    rfm = (
        players[["player_id", "player_last_name", "tier", "lifetime_adt",
                 "last_visit_date", "self_excluded", "do_not_market"]]
        .merge(gaming, on="player_id", how="left")
        .merge(events, on="player_id", how="left")
    )
    measures = ["rated_sessions", "visit_days", "coin_in", "coin_out",
                "theoretical_win", "actual_win", "comp_value", "avg_bet",
                "avg_session_minutes", "game_variety", "zones_played",
                "handle_events", "jackpots", "cash_in_amount"]
    rfm[measures] = rfm[measures].fillna(0)

    rfm["recency_days"] = (as_of - rfm["last_visit_date"]).dt.days
    rfm["frequency"] = rfm["rated_sessions"] + rfm["handle_events"]

    rfm["r_score"] = rfm_score(rfm["recency_days"], higher_is_better=False)
    rfm["f_score"] = rfm_score(rfm["frequency"])
    rfm["m_score"] = rfm_score(rfm["coin_in"])
    rfm["rfm_score"] = rfm["r_score"] * 100 + rfm["f_score"] * 10 + rfm["m_score"]

    def segment(row):
        r, f, m = row["r_score"], row["f_score"], row["m_score"]
        if r >= 4 and f >= 4 and m >= 4:
            return "VIP"
        if r >= 3 and f >= 3:
            return "Loyal"
        if r >= 4 and f <= 2:
            return "New"
        if r <= 2 and f >= 3:
            return "At Risk"
        if r <= 2 and f <= 2:
            return "Lost"
        return "Regular"

    rfm["segment"] = rfm.apply(segment, axis=1)

    # ADT (average daily theoretical) and comp efficiency - the two numbers a
    # player-development host actually works from. Comps should stay under ~40%
    # of theoretical win.
    rfm["observed_adt"] = (rfm["theoretical_win"] /
                           rfm["visit_days"].replace(0, np.nan)).round(2)
    rfm["comp_efficiency_pct"] = (
        100.0 * rfm["comp_value"] / rfm["theoretical_win"].replace(0, np.nan)
    ).round(1)

    # Annualised LTV is projected ONLY when the observed window can support it.
    # Extrapolating a full year from a few days of play would be a made-up number.
    projected = window_days >= LTV_MIN_WINDOW_DAYS
    if projected:
        rfm["projected_visits_per_year"] = (
            rfm["visit_days"] * 365.0 / window_days).round(1)
        rfm["projected_annual_ltv"] = (
            rfm["observed_adt"] * rfm["projected_visits_per_year"]).round(2)

    meta = {"as_of": as_of, "window_days": window_days, "ltv_projected": projected}
    return rfm.sort_values("rfm_score", ascending=False).reset_index(drop=True), meta


player_rfm, rfm_meta = compute_rfm(sessions, handles, dim_player)

value_cols = ["observed_adt", "lifetime_adt", "comp_efficiency_pct"]
if rfm_meta["ltv_projected"]:
    value_cols += ["projected_visits_per_year", "projected_annual_ltv"]
else:
    print("NOTE: the warehouse holds %d day(s) of session history, below the "
          "%d-day minimum for an annualised LTV projection, so value is ranked "
          "on observed ADT and the dimension's maintained lifetime_adt rather "
          "than on a projected figure."
          % (rfm_meta["window_days"], LTV_MIN_WINDOW_DAYS))

print("Players scored: %d   (recency as-of %s)"
      % (len(player_rfm), rfm_meta["as_of"].date()))
print("")
print("Segment distribution:")
print(player_rfm["segment"].value_counts().to_string())
print("")
print(player_rfm[["player_id", "player_last_name", "tier", "segment",
                  "recency_days", "frequency", "coin_in", "theoretical_win"]
                 + value_cols + ["rfm_score"]].to_string(index=False))
`;

const PVA_CHURN = `# Churn risk - a transparent scorecard first, then a classifier whose validation
# basis is chosen by the sample size and printed alongside the result.
#
# The scorecard is the deliverable that always holds: deterministic, explainable
# to a player-development host, and correct at any row count.
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import LeaveOneOut, cross_val_predict, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CHURN_DAYS = 30             # dbt var churn_medium_risk_days
CHURN_HIGH_RISK_DAYS = 45   # dbt var churn_high_risk_days
MIN_ROWS_FOR_HOLDOUT = 30   # below this a hold-out split is not informative
MIN_ROWS_FOR_LOOCV = 5      # below this not even leave-one-out is meaningful


def churn_scorecard(rfm):
    df = rfm.copy()
    df["is_churn_risk"] = (df["recency_days"] > CHURN_DAYS).astype(int)
    df["risk_band"] = pd.cut(
        df["recency_days"],
        bins=[-1, 14, CHURN_DAYS, CHURN_HIGH_RISK_DAYS, 90, 10 ** 6],
        labels=["ACTIVE", "WATCH", "AT_RISK", "HIGH_RISK", "LAPSED"],
    ).astype(str)
    # r/f/m are already 1..5; invert the weighted sum into a 0-100 risk score.
    df["churn_risk_score"] = (
        100 - (df["r_score"] * 12 + df["f_score"] * 5 + df["m_score"] * 3)
    ).clip(lower=0, upper=100)
    # What walks out of the door if they do not come back.
    df["value_at_risk"] = df["lifetime_adt"].fillna(0).round(2)
    df["contactable"] = ~(df["self_excluded"].astype(bool)
                          | df["do_not_market"].astype(bool))
    return df.sort_values(["churn_risk_score", "value_at_risk"],
                          ascending=[False, False]).reset_index(drop=True)


def churn_classifier(scored):
    """Fit LogReg / RandomForest / GBM on BEHAVIOURAL features.

    recency_days DEFINES the label, so it is excluded from the feature set -
    feeding it back in would leak the label and return a meaningless perfect
    score.
    """
    features = ["frequency", "rated_sessions", "visit_days", "coin_in",
                "theoretical_win", "actual_win", "comp_value", "avg_bet",
                "avg_session_minutes", "game_variety", "zones_played",
                "handle_events"]
    X = scored[features].fillna(0).astype(float)
    y = scored["is_churn_risk"].astype(int)
    n = len(X)
    balance = y.value_counts().to_dict()
    print("Churn model input: %d players, %d behavioural features, "
          "class balance %s" % (n, len(features), balance))

    if y.nunique() < 2:
        print("SKIPPED: every player falls in the same class, so there is "
              "nothing to separate. The scorecard above is the churn output "
              "for this warehouse.")
        return None

    # Validation strategy by sample size. Every branch reports a number that is
    # TRUE of what it measured, and says which it is.
    min_class = min(balance.values())
    if n >= MIN_ROWS_FOR_HOLDOUT and min_class >= 2:
        mode = "holdout"
        X_tr, X_te, y_tr, y_te = train_test_split(
            X, y, test_size=0.25, stratify=y, random_state=42)
        basis = "stratified hold-out (%d train / %d test)" % (len(X_tr), len(X_te))
    elif n >= MIN_ROWS_FOR_LOOCV and min_class >= 2:
        mode = "loocv"
        basis = ("leave-one-out cross-validation over all %d rows - below the "
                 "%d-row hold-out minimum, so every prediction below comes from "
                 "a model that never saw that player. A real generalisation "
                 "estimate, not an in-sample fit." % (n, MIN_ROWS_FOR_HOLDOUT))
    else:
        mode = "insample"
        basis = ("IN-SAMPLE on all %d rows - too few rows, or too few in one "
                 "class, for any hold-out or cross-validated estimate, so these "
                 "figures describe the FIT, not generalisation" % n)
    print("Validation basis: %s" % basis)

    results = {}
    for name, model in (
        ("logreg", LogisticRegression(max_iter=1000, random_state=42)),
        ("rf", RandomForestClassifier(n_estimators=200, max_depth=6, random_state=42)),
        ("gbm", GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=42)),
    ):
        # Scaling inside the pipeline so it is re-fit per CV fold rather than
        # leaking the held-out row's statistics into training.
        pipe = make_pipeline(StandardScaler(), model)
        if mode == "holdout":
            pipe.fit(X_tr, y_tr)
            truth, pred = y_te, pipe.predict(X_te)
            prob = pipe.predict_proba(X_te)[:, 1]
        elif mode == "loocv":
            cv = LeaveOneOut()
            truth = y
            pred = cross_val_predict(pipe, X, y, cv=cv)
            prob = cross_val_predict(pipe, X, y, cv=cv, method="predict_proba")[:, 1]
        else:
            pipe.fit(X, y)
            truth, pred = y, pipe.predict(X)
            prob = pipe.predict_proba(X)[:, 1]
        f1 = f1_score(truth, pred, zero_division=0)
        try:
            auc = roc_auc_score(truth, prob)
        except ValueError:
            auc = float("nan")   # a single-class evaluation set has no AUC
        pipe.fit(X, y)           # final model sees everything, for scoring new players
        results[name] = {"model": pipe, "f1": f1, "auc": auc, "basis": mode}
        print("  %-7s F1=%.3f  AUC=%.3f" % (name, f1, auc))
        _mlflow_log(MLFLOW_EXPERIMENT, "churn_%s" % name,
                    {"f1": f1, "auc": auc, "rows": n})
    return results


churn_scored = churn_scorecard(player_rfm)
print("Churn-risk scorecard (highest risk first):")
print(churn_scored[["player_id", "player_last_name", "tier", "risk_band",
                    "recency_days", "churn_risk_score", "value_at_risk",
                    "contactable"]].to_string(index=False))
print("")
print("Risk-band distribution:")
print(churn_scored["risk_band"].value_counts().to_string())
print("")
churn_models = churn_classifier(churn_scored)
`;

const PVA_SAVE = `# Persist the RFM segments and the churn scorecard as Delta tables in a Spark
# database, so downstream notebooks, the SQL endpoint, and the floor-operations
# dashboard can read them. The warehouse itself is a dedicated SQL pool, which
# needs a staging grant to write into, so outputs land in the Spark catalog.

GOLD_DB = loom_get_arg("gold_db") or spark.conf.get("spark.loom.goldDb", "casino_gold")
spark.sql("CREATE DATABASE IF NOT EXISTS %s" % GOLD_DB)

analysis_date = pd.Timestamp.today().normalize()


def save_gold(pdf, table, columns):
    out = pdf[[c for c in columns if c in pdf.columns]].copy()
    for col in out.columns:
        if str(out[col].dtype) == "category":
            out[col] = out[col].astype(str)
    out["analysis_date"] = analysis_date
    full_name = "%s.%s" % (GOLD_DB, table)
    try:
        (spark.createDataFrame(out)
            .write.mode("overwrite").option("overwriteSchema", "true")
            .format("delta").saveAsTable(full_name))
    except Exception as exc:
        raise RuntimeError(
            "Could not write %s. Observed: %s. If that is an authorization "
            "failure, grant the Spark identity Storage Blob Data Contributor on "
            "the Synapse workspace's primary ADLS Gen2 account."
            % (full_name, exc)) from exc
    # Verify by reading back rather than assuming the write landed.
    written = spark.table(full_name).count()
    if written == 0:
        raise RuntimeError("%s wrote 0 rows - the save did not land." % full_name)
    print("  %-40s %d rows" % (full_name, written))
    return written


print("Writing gold outputs:")
save_gold(player_rfm, "gld_player_rfm_segments",
          ["player_id", "player_last_name", "tier", "segment", "rfm_score",
           "r_score", "f_score", "m_score", "recency_days", "frequency",
           "rated_sessions", "visit_days", "coin_in", "coin_out",
           "theoretical_win", "actual_win", "comp_value", "observed_adt",
           "lifetime_adt", "comp_efficiency_pct", "projected_visits_per_year",
           "projected_annual_ltv"])
save_gold(churn_scored, "gld_player_churn_risk",
          ["player_id", "player_last_name", "tier", "segment", "risk_band",
           "is_churn_risk", "churn_risk_score", "recency_days",
           "value_at_risk", "contactable"])

print("")
print("Outputs:")
print("  %s.gld_player_rfm_segments" % GOLD_DB)
print("  %s.gld_player_churn_risk" % GOLD_DB)
print("  MLflow experiment (when the runtime provides one): %s" % MLFLOW_EXPERIMENT)
`;

// Floor optimization notebook cells.
const FLR_INTRO_MD = `# Casino Floor Optimization

Floor and slot analytics over the **casino star schema this app installs** — no
silver layer to build first, no Microsoft Fabric, no external dataset.

| Source table | Used for |
|---|---|
| casino.dim_table | machine / table inventory, floor zone, target hold, par-sheet RTP |
| casino.fact_session | rated play per machine: coin-in, coin-out, theo and actual win |
| casino.fact_handle | event-level play: spins, jackpots, hand pays, Title 31 triggers |
| casino.dim_date | gaming-day calendar |

What the cells below produce:

- **Machine performance ranking** — revenue, actual hold vs target, actual RTP
- **Zone optimisation** — revenue density, an optimisation score (0-100), and a
  recommendation per zone: ADD_MACHINES / REMOVE_MACHINES /
  CHANGE_DENOMINATION_MIX / REVIEW_PAR_SHEETS / MONITOR
- **A GBM revenue model** whose validation basis is chosen by the sample size
  and printed with the machine count
- **KMeans clustering** of machines by performance profile, with k swept only
  over the range the sample actually supports

The warehouse is an Azure Synapse **dedicated SQL pool**, so cells read it with
spark.read.synapsesql — the Synapse dedicated-pool connector, a default library
in every Synapse workspace.

> All seed data is **entirely synthetic**.
`;

const FLR_SETUP = `# Setup - resolve the warehouse and define the reader every cell below uses.
${NB_WAREHOUSE_PREFACE}
MLFLOW_EXPERIMENT = "/Casino/floor_optimization"

print("Warehouse: %s.%s" % (WAREHOUSE_DB, WAREHOUSE_SCHEMA))
`;

const FLR_LOAD = `# Load the machine inventory and both play facts.
print("Loading casino star schema:")
dim_table = read_warehouse("dim_table")
dim_date = read_warehouse("dim_date")
fact_session = read_warehouse("fact_session")
fact_handle = read_warehouse("fact_handle")

dim_date["full_date"] = pd.to_datetime(dim_date["full_date"])
fact_session["session_start"] = pd.to_datetime(fact_session["session_start"])
fact_handle["event_ts"] = pd.to_datetime(fact_handle["event_ts"])

sessions = fact_session.merge(
    dim_date[["date_sk", "full_date", "is_weekend", "day_name"]],
    on="date_sk", how="left")
handles = fact_handle.merge(
    dim_date[["date_sk", "full_date", "is_weekend"]], on="date_sk", how="left")

print("")
print("Machines / tables: %d across zones %s"
      % (len(dim_table), ", ".join(sorted(dim_table["floor_zone"].unique()))))
print("Rated sessions:    %d over %d gaming days"
      % (len(sessions), sessions["date_sk"].nunique()))
print("Handle events:     %d (%s)"
      % (len(handles), ", ".join(sorted(handles["event_type"].unique()))))
`;

const FLR_PERF = `# Machine performance - revenue, actual hold vs target, and actual RTP per
# machine. dim_table is the LEFT side so a machine with no play in the window
# still appears (at zero) instead of silently vanishing from the ranking.

def machine_performance(tables, sessions, handles):
    per_session = (
        sessions.groupby("table_sk")
        .agg(rated_sessions=("session_id", "count"),
             unique_players=("player_sk", "nunique"),
             active_days=("date_sk", "nunique"),
             coin_in=("coin_in", "sum"),
             coin_out=("coin_out", "sum"),
             theoretical_win=("theoretical_win", "sum"),
             actual_win=("actual_win", "sum"),
             comp_value=("comp_value", "sum"),
             avg_session_minutes=("duration_minutes", "mean"))
        .reset_index()
    )
    per_event = (
        handles.groupby("table_sk")
        .agg(handle_events=("event_id", "count"),
             jackpot_events=("jackpot_amount", lambda s: int(s.notna().sum())),
             jackpot_amount=("jackpot_amount", "sum"),
             hand_pay_amount=("hand_pay_amount", "sum"),
             ctr_events=("ctr_trigger", lambda s: int(s.astype(bool).sum())),
             avg_rtp_contribution=("rtp_contribution", "mean"))
        .reset_index()
    )
    spins = handles[handles["event_type"] == "SPIN"]
    per_spin = (
        spins.groupby("table_sk")
        .agg(total_spins=("event_id", "count"),
             credits_wagered=("credits_wagered", "sum"),
             credits_won=("credits_won", "sum"))
        .reset_index()
    )

    perf = (
        tables[["table_sk", "table_id", "table_type", "game_theme", "floor_zone",
                "denomination", "target_hold_pct", "par_sheet_rtp_pct",
                "is_active"]]
        .merge(per_session, on="table_sk", how="left")
        .merge(per_event, on="table_sk", how="left")
        .merge(per_spin, on="table_sk", how="left")
    )
    measures = ["rated_sessions", "unique_players", "active_days", "coin_in",
                "coin_out", "theoretical_win", "actual_win", "comp_value",
                "avg_session_minutes", "handle_events", "jackpot_events",
                "jackpot_amount", "hand_pay_amount", "ctr_events",
                "total_spins", "credits_wagered", "credits_won"]
    perf[measures] = perf[measures].fillna(0)

    perf["revenue"] = (perf["coin_in"] - perf["coin_out"]).round(2)
    perf["actual_hold_pct"] = np.where(
        perf["coin_in"] > 0,
        100.0 * (perf["coin_in"] - perf["coin_out"]) / perf["coin_in"],
        0.0).round(2)
    perf["hold_variance_pct"] = (perf["actual_hold_pct"]
                                 - perf["target_hold_pct"]).round(2)
    perf["actual_rtp_pct"] = np.where(
        perf["credits_wagered"] > 0,
        100.0 * perf["credits_won"] / perf["credits_wagered"],
        np.nan).round(2)
    perf["revenue_per_day"] = np.where(
        perf["active_days"] > 0, perf["revenue"] / perf["active_days"],
        0.0).round(2)
    perf["hold_status"] = np.where(
        perf["hold_variance_pct"].abs() <= 1.0, "ON_TARGET",
        np.where(perf["hold_variance_pct"] > 1.0, "ABOVE_TARGET",
                 "BELOW_TARGET"))
    return perf.sort_values("revenue", ascending=False).reset_index(drop=True)


machine_perf = machine_performance(dim_table, sessions, handles)

print("Machine performance (%d machines, highest revenue first):"
      % len(machine_perf))
print(machine_perf[["table_id", "table_type", "game_theme", "floor_zone",
                    "denomination", "rated_sessions", "total_spins",
                    "coin_in", "coin_out", "revenue", "actual_hold_pct",
                    "target_hold_pct", "hold_variance_pct", "actual_rtp_pct",
                    "hold_status"]].to_string(index=False))
print("")
print("Hold status distribution:")
print(pd.Series(machine_perf["hold_status"]).value_counts().to_string())
`;

const FLR_ZONE = `# Zone optimisation - the rollup a floor manager acts on. Mirrors the
# gld_floor_optimization dbt model: a 0-100 composite of revenue density (40),
# utilisation (30), and hold accuracy (20), plus a recommendation per zone.

def zone_optimization(perf):
    zone = (
        perf.groupby("floor_zone")
        .agg(machines=("table_sk", "count"),
             active_days=("active_days", "max"),
             unique_players=("unique_players", "sum"),
             rated_sessions=("rated_sessions", "sum"),
             coin_in=("coin_in", "sum"),
             coin_out=("coin_out", "sum"),
             revenue=("revenue", "sum"),
             theoretical_win=("theoretical_win", "sum"),
             avg_session_minutes=("avg_session_minutes", "mean"),
             target_hold_pct=("target_hold_pct", "mean"),
             jackpot_events=("jackpot_events", "sum"),
             ctr_events=("ctr_events", "sum"))
        .reset_index()
    )
    zone["actual_hold_pct"] = np.where(
        zone["coin_in"] > 0,
        100.0 * (zone["coin_in"] - zone["coin_out"]) / zone["coin_in"],
        0.0).round(2)
    zone["hold_variance_pct"] = (zone["actual_hold_pct"]
                                 - zone["target_hold_pct"]).round(2)
    zone["revenue_per_machine_day"] = np.where(
        (zone["machines"] > 0) & (zone["active_days"] > 0),
        zone["revenue"] / (zone["machines"] * zone["active_days"]),
        0.0).round(2)

    revenue_points = np.clip(zone["revenue_per_machine_day"] / 50.0 * 40, 0, 40)
    utilisation_points = np.clip(zone["avg_session_minutes"] / 240.0 * 30, 0, 30)
    hold_points = np.select(
        [zone["hold_variance_pct"].abs() <= 0.5,
         zone["hold_variance_pct"].abs() <= 1.0,
         zone["hold_variance_pct"].abs() <= 2.0],
        [20, 15, 10], default=5)
    zone["optimization_score"] = (
        revenue_points + utilisation_points + hold_points).round(1)

    zone["recommendation"] = np.select(
        [(zone["revenue_per_machine_day"] < 20) & (zone["avg_session_minutes"] < 30),
         (zone["revenue_per_machine_day"] < 30) & (zone["avg_session_minutes"] > 120),
         (zone["revenue_per_machine_day"] > 80) & (zone["avg_session_minutes"] > 120),
         zone["hold_variance_pct"].abs() > 2.0],
        ["REMOVE_MACHINES", "CHANGE_DENOMINATION_MIX", "ADD_MACHINES",
         "REVIEW_PAR_SHEETS"],
        default="MONITOR")
    return zone.sort_values("optimization_score",
                            ascending=False).reset_index(drop=True)


zone_perf = zone_optimization(machine_perf)

print("Zone optimisation (%d zones, best score first):" % len(zone_perf))
print(zone_perf[["floor_zone", "machines", "rated_sessions", "unique_players",
                 "coin_in", "revenue", "revenue_per_machine_day",
                 "actual_hold_pct", "target_hold_pct", "hold_variance_pct",
                 "optimization_score", "recommendation"]].to_string(index=False))
print("")
print("Recommendations: %s"
      % pd.Series(zone_perf["recommendation"]).value_counts().to_dict())
print("Title 31 CTR-triggering events on the floor: %d"
      % int(zone_perf["ctr_events"].sum()))
`;

const FLR_REV_MODEL = `# Revenue prediction - a GBM regressor over machine attributes. The validation
# basis follows the sample size and is printed with the result, so an in-sample
# fit is never mistaken for a generalisation estimate.
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import LeaveOneOut, cross_val_predict, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import LabelEncoder, StandardScaler

MIN_MACHINES_FOR_HOLDOUT = 25
MIN_MACHINES_FOR_LOOCV = 5


def predict_machine_revenue(perf):
    df = perf.copy()
    df["zone_encoded"] = LabelEncoder().fit_transform(df["floor_zone"].astype(str))
    df["type_encoded"] = LabelEncoder().fit_transform(df["table_type"].astype(str))
    features = ["total_spins", "handle_events", "rated_sessions",
                "unique_players", "coin_in", "avg_session_minutes",
                "denomination", "target_hold_pct", "zone_encoded",
                "type_encoded"]
    X = df[features].fillna(0).astype(float)
    y = df["revenue"].astype(float)
    n = len(X)
    print("Revenue model input: %d machines, %d features" % (n, len(features)))

    if n < 3:
        print("SKIPPED: %d machine(s) is too few to fit a regressor. The "
              "per-machine and per-zone rankings above are the floor output "
              "for this warehouse." % n)
        return None

    if n >= MIN_MACHINES_FOR_HOLDOUT:
        mode = "holdout"
        X_tr, X_te, y_tr, y_te = train_test_split(
            X, y, test_size=0.25, random_state=42)
        basis = "hold-out (%d train / %d test)" % (len(X_tr), len(X_te))
    elif n >= MIN_MACHINES_FOR_LOOCV:
        mode = "loocv"
        basis = ("leave-one-out cross-validation over all %d machines - below "
                 "the %d-machine hold-out minimum, so every prediction below "
                 "comes from a model that never saw that machine. A real "
                 "generalisation estimate, not an in-sample fit."
                 % (n, MIN_MACHINES_FOR_HOLDOUT))
    else:
        mode = "insample"
        basis = ("IN-SAMPLE on all %d machines - too few for any hold-out or "
                 "cross-validated estimate, so these figures describe the FIT, "
                 "not generalisation" % n)
    print("Validation basis: %s" % basis)

    # Scaling inside the pipeline so it is re-fit per CV fold rather than
    # leaking the held-out machine's statistics into training.
    pipe = make_pipeline(
        StandardScaler(),
        GradientBoostingRegressor(n_estimators=100, max_depth=3, random_state=42))
    if mode == "holdout":
        pipe.fit(X_tr, y_tr)
        truth, pred = y_te, pipe.predict(X_te)
    elif mode == "loocv":
        truth = y
        pred = cross_val_predict(pipe, X, y, cv=LeaveOneOut())
    else:
        pipe.fit(X, y)
        truth, pred = y, pipe.predict(X)
    mae = mean_absolute_error(truth, pred)
    r2 = r2_score(truth, pred) if len(truth) > 1 else float("nan")
    print("  MAE = %.2f   R2 = %.4f" % (mae, r2))
    if mode == "loocv" and r2 < 0:
        print("  A negative R2 under leave-one-out means the floor is still too "
              "small for the model to beat simply predicting the mean - expected "
              "at %d machines, and the honest read of this sample. It rises as "
              "real play accumulates; the per-machine and per-zone rankings "
              "above do not depend on it." % n)

    pipe.fit(X, y)   # final model sees every machine, for scoring new ones
    model = pipe.steps[-1][1]   # the fitted regressor at the end of the pipeline
    drivers = (pd.DataFrame({"feature": features,
                             "importance": model.feature_importances_})
               .sort_values("importance", ascending=False)
               .head(6).round(4))
    print("")
    print("Top revenue drivers (fitted on all %d machines):" % n)
    print(drivers.to_string(index=False))
    _mlflow_log(MLFLOW_EXPERIMENT, "floor_revenue_gbm",
                {"mae": mae, "r2": r2, "machines": n})
    return pipe


revenue_model = predict_machine_revenue(machine_perf)
`;

const FLR_CLUSTER = `# Cluster machines by performance profile to find the optimisation groups.
#
# k is swept only over the range the SAMPLE supports: a silhouette score needs
# at least 2 clusters and at most n-1, so the upper bound is derived from the
# machine count rather than being a fixed literal that throws on a small floor.
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

MAX_CLUSTERS = 8


def cluster_machines(perf):
    cols = ["total_spins", "handle_events", "revenue", "actual_hold_pct",
            "hold_variance_pct", "denomination", "unique_players",
            "avg_session_minutes"]
    X = perf[cols].fillna(0).astype(float)
    n = len(X)
    k_max = min(MAX_CLUSTERS, n - 1)
    print("Clustering input: %d machines, %d features" % (n, len(cols)))

    if k_max < 2:
        print("SKIPPED: %d machine(s) supports no valid k - a silhouette score "
              "needs 2 <= k <= n-1. The per-machine and per-zone rankings above "
              "are the floor output for this warehouse." % n)
        perf["cluster"] = 0
        return perf, None

    X_scaled = StandardScaler().fit_transform(X)
    scores = {}
    for k in range(2, k_max + 1):
        labels = KMeans(n_clusters=k, random_state=42, n_init=10).fit_predict(X_scaled)
        scores[k] = round(float(silhouette_score(X_scaled, labels)), 3)
    best_k = max(scores, key=scores.get)
    print("  silhouette by k (2..%d): %s" % (k_max, scores))
    print("  best k = %d (silhouette %.3f)" % (best_k, scores[best_k]))

    perf["cluster"] = KMeans(n_clusters=best_k, random_state=42,
                             n_init=10).fit_predict(X_scaled)
    summary = (perf.groupby("cluster")
               .agg(machines=("table_id", "count"),
                    avg_revenue=("revenue", "mean"),
                    total_revenue=("revenue", "sum"),
                    avg_hold_variance=("hold_variance_pct", "mean"),
                    zones=("floor_zone", lambda s: ",".join(sorted(set(s)))))
               .round(2))
    print("")
    print(summary.to_string())
    _mlflow_log(MLFLOW_EXPERIMENT, "floor_kmeans",
                {"k": best_k, "silhouette": scores[best_k], "machines": n})
    return perf, summary


machine_perf, cluster_summary = cluster_machines(machine_perf)
`;

const FLR_SAVE = `# Persist the machine and zone outputs as Delta tables in a Spark database for
# the floor-operations dashboard. The warehouse itself is a dedicated SQL pool,
# which needs a staging grant to write into, so outputs land in the Spark catalog.

GOLD_DB = loom_get_arg("gold_db") or spark.conf.get("spark.loom.goldDb", "casino_gold")
spark.sql("CREATE DATABASE IF NOT EXISTS %s" % GOLD_DB)

analysis_date = pd.Timestamp.today().normalize()


def save_gold(pdf, table, columns):
    out = pdf[[c for c in columns if c in pdf.columns]].copy()
    for col in out.columns:
        if str(out[col].dtype) == "category":
            out[col] = out[col].astype(str)
    out["analysis_date"] = analysis_date
    full_name = "%s.%s" % (GOLD_DB, table)
    try:
        (spark.createDataFrame(out)
            .write.mode("overwrite").option("overwriteSchema", "true")
            .format("delta").saveAsTable(full_name))
    except Exception as exc:
        raise RuntimeError(
            "Could not write %s. Observed: %s. If that is an authorization "
            "failure, grant the Spark identity Storage Blob Data Contributor on "
            "the Synapse workspace's primary ADLS Gen2 account."
            % (full_name, exc)) from exc
    # Verify by reading back rather than assuming the write landed.
    written = spark.table(full_name).count()
    if written == 0:
        raise RuntimeError("%s wrote 0 rows - the save did not land." % full_name)
    print("  %-44s %d rows" % (full_name, written))
    return written


print("Writing gold outputs:")
save_gold(machine_perf, "gld_machine_performance",
          ["table_id", "table_type", "game_theme", "floor_zone", "denomination",
           "rated_sessions", "unique_players", "active_days", "total_spins",
           "handle_events", "jackpot_events", "ctr_events", "coin_in",
           "coin_out", "revenue", "revenue_per_day", "theoretical_win",
           "actual_win", "actual_hold_pct", "target_hold_pct",
           "hold_variance_pct", "actual_rtp_pct", "par_sheet_rtp_pct",
           "hold_status", "cluster"])
save_gold(zone_perf, "gld_floor_zone_optimization",
          ["floor_zone", "machines", "rated_sessions", "unique_players",
           "coin_in", "coin_out", "revenue", "revenue_per_machine_day",
           "actual_hold_pct", "target_hold_pct", "hold_variance_pct",
           "jackpot_events", "ctr_events", "optimization_score",
           "recommendation"])

print("")
print("Outputs:")
print("  %s.gld_machine_performance" % GOLD_DB)
print("  %s.gld_floor_zone_optimization" % GOLD_DB)
print("  MLflow experiment (when the runtime provides one): %s" % MLFLOW_EXPERIMENT)
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
    // is_holiday is NOT NULL (dedicated pool DEFAULT constraints dropped from
    // the DDL) so it is seeded explicitly.
    table: 'casino.dim_date',
    columns: [
      'date_sk', 'full_date', 'day_of_week', 'day_name', 'is_weekend',
      'is_holiday', 'week_of_year', 'month_num', 'month_name', 'quarter_num',
      'year_num', 'gaming_day_start',
    ],
    rows: [
      [20260530, '2026-05-30', 7, 'Saturday', 1, 0, 22, 5, 'May', 2, 2026, '2026-05-30T06:00:00'],
      [20260529, '2026-05-29', 6, 'Friday',   1, 0, 22, 5, 'May', 2, 2026, '2026-05-29T06:00:00'],
      [20260528, '2026-05-28', 5, 'Thursday', 0, 0, 22, 5, 'May', 2, 2026, '2026-05-28T06:00:00'],
    ],
  },
  {
    // net_result is a persisted column (= coin_in - coin_out) since dedicated
    // SQL pool has no computed columns — seed it explicitly per row.
    table: 'casino.fact_session',
    columns: [
      'session_sk', 'session_id', 'player_sk', 'table_sk', 'date_sk',
      'session_start', 'session_end', 'duration_minutes', 'game_type',
      'coin_in', 'coin_out', 'theoretical_win', 'actual_win', 'net_result',
      'avg_bet', 'rated_play', 'comp_value', 'session_rating', 'floor_zone',
      'ingest_ts',
    ],
    rows: [
      [1, 'S2026053000001', 1, 3, 20260530, '2026-05-30T20:15:00', '2026-05-30T23:40:00', 205, 'BLACKJACK', 84000.00, 31000.00, 5040.00, 53000.00, 53000.00, 250.00, 1, 1200.00, 5, 'VIP', '2026-05-31T06:05:00'],
      [2, 'S2026053000002', 2, 1, 20260530, '2026-05-30T18:30:00', '2026-05-30T20:05:00',  95, 'SLOT',      12500.00,  9800.00,  1000.00,  2700.00,  2700.00,   5.00, 1,  150.00, 4, 'A1',  '2026-05-31T06:05:00'],
      [3, 'S2026052900001', 3, 4, 20260529, '2026-05-29T13:10:00', '2026-05-29T15:00:00', 110, 'SLOT',       3400.00,  3050.00,   289.00,   350.00,   350.00,   2.50, 1,   40.00, 3, 'B1',  '2026-05-30T06:05:00'],
      [4, 'S2026052900002', 4, 2, 20260529, '2026-05-29T11:00:00', '2026-05-29T11:45:00',  45, 'SLOT',        900.00,   840.00,    81.00,    60.00,    60.00,   1.25, 1,   10.00, 2, 'A2',  '2026-05-30T06:05:00'],
      [5, 'S2026052800001', 5, 5, 20260528, '2026-05-28T22:05:00', '2026-05-28T22:35:00',  30, 'ROULETTE',     600.00,   570.00,    31.56,    30.00,    30.00,  20.00, 1,    5.00, 1, 'C1',  '2026-05-29T06:05:00'],
    ],
  },
  {
    // coin_in_amount / coin_out_amount are persisted columns (= credits_wagered
    // * denomination / credits_won * denomination) since dedicated SQL pool has
    // no computed columns — seed them explicitly per row.
    table: 'casino.fact_handle',
    columns: [
      'handle_sk', 'event_id', 'session_sk', 'player_sk', 'table_sk',
      'date_sk', 'event_ts', 'event_type', 'denomination', 'credits_wagered',
      'credits_won', 'coin_in_amount', 'coin_out_amount', 'jackpot_amount',
      'hand_pay_amount', 'rtp_contribution', 'floor_zone', 'ctr_trigger',
      'ingest_ts',
    ],
    rows: [
      [1, 'E20260530A0001', 2, 2, 1, 20260530, '2026-05-30T18:31:12', 'SPIN',     1.00,   500,    0,   500.00,     0.00, null,     null, 0.9100, 'A1',  0, '2026-05-31T06:05:00'],
      [2, 'E20260530A0002', 2, 2, 1, 20260530, '2026-05-30T18:42:55', 'JACKPOT',  1.00,   500, 2500,   500.00,  2500.00, 2500.00,  null, 0.9100, 'A1',  0, '2026-05-31T06:05:00'],
      [3, 'E20260530V0001', 1, 1, 3, 20260530, '2026-05-30T21:05:00', 'CASH_IN',  1.00, 12000,    0, 12000.00,     0.00, null,     null, null,   'VIP', 1, '2026-05-31T06:05:00'],
      [4, 'E20260530V0002', 1, 1, 3, 20260530, '2026-05-30T22:50:00', 'HAND_PAY', 1.00,     0, 9000,     0.00,  9000.00, null,  9000.00, null,   'VIP', 0, '2026-05-31T06:05:00'],
      [5, 'E20260529B0001', 3, 3, 4, 20260529, '2026-05-29T13:15:30', 'SPIN',     0.50,   100,   80,    50.00,    40.00, null,     null, 0.9200, 'B1',  0, '2026-05-30T06:05:00'],
      [6, 'E20260528C0001', 5, 5, 5, 20260528, '2026-05-28T22:10:00', 'SPIN',     1.00,    20,    0,    20.00,     0.00, null,     null, 0.9474, 'C1',  0, '2026-05-29T06:05:00'],
    ],
  },
];

// ─── Bundle ─────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-casino-analytics',
  intro:
    'Reference architecture for tribal-casino operations analytics: ' +
    'player-grain warehouse (sessions + handles), high-roller Activator ' +
    'alerts wired to Teams, and two starter notebooks that read that same ' +
    'warehouse for RFM/LTV/churn modeling and floor optimization. ' +
    'Compliance-aware: NIGC MICS, Title 31 ' +
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
        'Reads the casino star schema this app installs (dim_player, ' +
        'fact_session, fact_handle) straight from the Synapse dedicated SQL ' +
        'pool: RFM segmentation, a churn-risk scorecard, comp efficiency and ' +
        'ADT, and a churn classifier (LogReg / RandomForest / GBM) whose ' +
        'validation basis is chosen by the sample size. Writes ' +
        'gld_player_rfm_segments + gld_player_churn_risk.',
      learnDoc: 'casino-analytics/player-value-notebook',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          cell('markdown', PVA_INTRO_MD),
          cell('markdown', '## Setup'),
          // Defines loom_get_arg/loom_get_secret so the setup cell below can
          // read its notebook parameters on Synapse, Databricks, Fabric or AML.
          backendUtilShimCell('casino-pva-backend-shim'),
          cell('code', PVA_SETUP),
          cell('markdown', '## Data Loading'),
          cell('code', PVA_LOAD),
          cell('markdown', '## RFM Analysis'),
          cell('code', PVA_RFM),
          cell('markdown', '## Churn Risk'),
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
        'Reads the casino star schema this app installs (dim_table, ' +
        'fact_session, fact_handle) straight from the Synapse dedicated SQL ' +
        'pool: machine performance with hold variance vs target, per-zone ' +
        'optimisation score and recommendation, a GBM revenue model, and ' +
        'KMeans clustering with k bounded by the machine count. Writes ' +
        'gld_machine_performance + gld_floor_zone_optimization.',
      learnDoc: 'casino-analytics/floor-optimization-notebook',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          cell('markdown', FLR_INTRO_MD),
          cell('markdown', '## Setup'),
          backendUtilShimCell('casino-floor-backend-shim'),
          cell('code', FLR_SETUP),
          cell('markdown', '## Data Loading'),
          cell('code', FLR_LOAD),
          cell('markdown', '## Machine Performance Analysis'),
          cell('code', FLR_PERF),
          cell('markdown', '## Zone Optimization'),
          cell('code', FLR_ZONE),
          cell('markdown', '## Revenue Prediction Model'),
          cell('code', FLR_REV_MODEL),
          cell('markdown', '## Machine Clustering'),
          cell('code', FLR_CLUSTER),
          cell('markdown', '## Save Results'),
          cell('code', FLR_SAVE),
        ],
      },
    },
  ],
};

export default bundle;
