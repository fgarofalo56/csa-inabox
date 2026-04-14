{{ config(
    materialized='table',
    tags=['gold', 'compliance', 'title31', 'aml', 'nigc', 'restricted']
) }}

/*
    Gold Layer — Title 31 Compliance Monitoring

    Detects and reports potential BSA/AML compliance triggers:
    - Currency Transaction Reports (CTR): Cash transactions >= $10,000 in a gaming day
    - Suspicious Activity Reports (SAR): Structured transactions designed to evade CTR
    - Multiple Transaction Logs (MTL): Aggregated cash activity per player per gaming day
    - Behavioral anomalies: Unusual play patterns suggesting money laundering

    Gaming day boundary: {{ var('gaming_day_start_hour') }}:00 to {{ var('gaming_day_start_hour') - 1 }}:59 next day.

    ACCESS RESTRICTED: Compliance officers and designated AML staff only.
    All data is ENTIRELY SYNTHETIC.
*/

WITH -- Define gaming day boundary (6 AM to 5:59 AM)
sessions_with_gaming_day AS (
    SELECT
        *,
        -- Gaming day: if hour < gaming_day_start, it belongs to previous day's gaming day
        CASE
            WHEN session_start IS NOT NULL AND HOUR(session_start) < {{ var('gaming_day_start_hour') }}
            THEN DATEADD(DAY, -1, session_date)
            ELSE session_date
        END AS gaming_day
    FROM {{ ref('slv_player_sessions') }}
),

-- Aggregate player cash activity per gaming day
player_gaming_day AS (
    SELECT
        player_id,
        gaming_day,

        -- Session counts
        COUNT(*) AS session_count,
        COUNT(DISTINCT machine_id) AS machines_played,

        -- Cash activity
        SUM(coin_in) AS total_coin_in,
        SUM(coin_out) AS total_coin_out,
        SUM(net_result) AS net_result,
        SUM(session_theoretical) AS total_theoretical,

        -- Session characteristics
        SUM(duration_minutes) AS total_play_minutes,
        AVG(avg_bet_estimate) AS avg_bet,
        MAX(coin_in) AS largest_single_session_coin_in,

        -- Time distribution
        MIN(session_start) AS first_session_time,
        MAX(session_start) AS last_session_time

    FROM sessions_with_gaming_day
    GROUP BY player_id, gaming_day
),

-- CTR detection: cash transactions >= $10,000
ctr_triggers AS (
    SELECT
        player_id,
        gaming_day,
        total_coin_in,
        total_coin_out,
        session_count,
        machines_played,
        total_play_minutes,

        -- CTR required when cash in or cash out >= $10,000
        CASE
            WHEN total_coin_in >= {{ var('ctr_threshold') }}
              OR total_coin_out >= {{ var('ctr_threshold') }}
            THEN TRUE
            ELSE FALSE
        END AS ctr_required,

        -- Amount triggering CTR
        GREATEST(total_coin_in, total_coin_out) AS ctr_trigger_amount,

        -- Percentage of threshold
        ROUND(GREATEST(total_coin_in, total_coin_out) / {{ var('ctr_threshold') }}.0 * 100, 1) AS pct_of_ctr_threshold

    FROM player_gaming_day
),

-- Structuring detection: pattern of transactions just below $10K
structuring_analysis AS (
    SELECT
        player_id,

        -- Count of gaming days with activity between $8K-$10K (structuring band)
        COUNT(CASE
            WHEN GREATEST(total_coin_in, total_coin_out) BETWEEN {{ var('structuring_threshold') }} AND {{ var('ctr_threshold') }} - 1
            THEN 1
        END) AS near_threshold_days,

        -- Total gaming days with any activity
        COUNT(*) AS total_gaming_days,

        -- Frequency of near-threshold activity
        CASE
            WHEN COUNT(*) > 0
            THEN ROUND(
                COUNT(CASE
                    WHEN GREATEST(total_coin_in, total_coin_out) BETWEEN {{ var('structuring_threshold') }} AND {{ var('ctr_threshold') }} - 1
                    THEN 1
                END)::DECIMAL / COUNT(*) * 100, 1
            )
            ELSE 0.0
        END AS near_threshold_frequency_pct,

        -- Pattern flag: 3+ near-threshold days in 30-day window
        CASE
            WHEN COUNT(CASE
                WHEN GREATEST(total_coin_in, total_coin_out) BETWEEN {{ var('structuring_threshold') }} AND {{ var('ctr_threshold') }} - 1
                    AND gaming_day >= DATEADD(DAY, -30, CURRENT_DATE())
                THEN 1
            END) >= 3
            THEN TRUE
            ELSE FALSE
        END AS structuring_pattern_detected,

        -- Average amount of near-threshold transactions
        AVG(CASE
            WHEN GREATEST(total_coin_in, total_coin_out) BETWEEN {{ var('structuring_threshold') }} AND {{ var('ctr_threshold') }} - 1
            THEN GREATEST(total_coin_in, total_coin_out)
        END) AS avg_near_threshold_amount

    FROM player_gaming_day
    GROUP BY player_id
),

-- Behavioral anomaly detection
behavioral_anomalies AS (
    SELECT
        pgd.player_id,

        -- Unusual play duration (very short sessions with high cash volume)
        CASE
            WHEN pgd.total_play_minutes < 30 AND GREATEST(pgd.total_coin_in, pgd.total_coin_out) > 5000
            THEN TRUE
            ELSE FALSE
        END AS short_session_high_volume,

        -- Unusual machine hopping (many machines, short sessions)
        CASE
            WHEN pgd.machines_played > 10 AND pgd.session_count > 10
            THEN TRUE
            ELSE FALSE
        END AS excessive_machine_hopping,

        -- Late night high-volume activity
        CASE
            WHEN HOUR(pgd.first_session_time) < {{ var('gaming_day_start_hour') }}
                 AND GREATEST(pgd.total_coin_in, pgd.total_coin_out) > 5000
            THEN TRUE
            ELSE FALSE
        END AS late_night_high_volume,

        pgd.gaming_day

    FROM player_gaming_day pgd
),

-- Combine all compliance metrics
compliance_report AS (
    SELECT
        ct.player_id,
        ct.gaming_day,
        ct.total_coin_in,
        ct.total_coin_out,
        ct.net_result,
        ct.session_count,
        ct.machines_played,
        ct.total_play_minutes,

        -- CTR metrics
        ct.ctr_required,
        ct.ctr_trigger_amount,
        ct.pct_of_ctr_threshold,

        -- Structuring detection
        sa.near_threshold_days,
        sa.near_threshold_frequency_pct,
        sa.structuring_pattern_detected,

        -- Behavioral flags
        COALESCE(ba.short_session_high_volume, FALSE) AS short_session_high_volume_flag,
        COALESCE(ba.excessive_machine_hopping, FALSE) AS machine_hopping_flag,
        COALESCE(ba.late_night_high_volume, FALSE) AS late_night_high_volume_flag,

        -- Overall risk score (0-100)
        ROUND(
            -- CTR threshold proximity (0-30 points)
            LEAST(ct.pct_of_ctr_threshold / 100.0 * 30, 30) +
            -- Structuring pattern (0-30 points)
            CASE WHEN sa.structuring_pattern_detected THEN 30
                 WHEN sa.near_threshold_days >= 2 THEN 20
                 WHEN sa.near_threshold_days >= 1 THEN 10
                 ELSE 0 END +
            -- Behavioral anomalies (0-20 points each, max 40)
            LEAST(
                (CASE WHEN COALESCE(ba.short_session_high_volume, FALSE) THEN 20 ELSE 0 END) +
                (CASE WHEN COALESCE(ba.excessive_machine_hopping, FALSE) THEN 15 ELSE 0 END) +
                (CASE WHEN COALESCE(ba.late_night_high_volume, FALSE) THEN 15 ELSE 0 END),
                40
            )
        , 1) AS risk_score,

        -- SAR recommendation
        CASE
            WHEN sa.structuring_pattern_detected AND ct.pct_of_ctr_threshold >= 80 THEN TRUE
            WHEN sa.near_threshold_days >= 3 THEN TRUE
            WHEN COALESCE(ba.short_session_high_volume, FALSE)
                 AND COALESCE(ba.excessive_machine_hopping, FALSE) THEN TRUE
            ELSE FALSE
        END AS sar_recommended,

        -- Recommended action
        CASE
            WHEN ct.ctr_required THEN 'FILE_CTR'
            WHEN sa.structuring_pattern_detected THEN 'INVESTIGATE_STRUCTURING'
            WHEN ct.pct_of_ctr_threshold >= 80 THEN 'MONITOR_THRESHOLD_APPROACH'
            WHEN COALESCE(ba.short_session_high_volume, FALSE) OR COALESCE(ba.excessive_machine_hopping, FALSE) THEN 'REVIEW_BEHAVIOR'
            ELSE 'NO_ACTION'
        END AS recommended_action,

        -- Metadata
        CURRENT_DATE() AS reporting_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM ctr_triggers ct
    LEFT JOIN structuring_analysis sa ON ct.player_id = sa.player_id
    LEFT JOIN behavioral_anomalies ba ON ct.player_id = ba.player_id AND ct.gaming_day = ba.gaming_day
    WHERE ct.pct_of_ctr_threshold >= 50  -- Only report players approaching 50% of threshold
       OR sa.structuring_pattern_detected = TRUE
       OR COALESCE(ba.short_session_high_volume, FALSE) = TRUE
       OR COALESCE(ba.excessive_machine_hopping, FALSE) = TRUE
)

SELECT * FROM compliance_report
ORDER BY risk_score DESC, gaming_day DESC
