{{ config(
    materialized='table',
    tags=['gold', 'floor', 'optimization', 'operations', 'analytics']
) }}

/*
    Gold Layer — Floor Layout Optimization

    Analyzes gaming floor performance at the zone level to support
    machine placement decisions, denomination mix optimization,
    and traffic flow analysis.

    Combines slot performance data with session patterns to produce:
    - Zone-level revenue and utilization metrics
    - Machine utilization rates (active hours / available hours)
    - Traffic patterns by day-of-week and hour
    - Optimal placement scores based on revenue and utilization
    - Hold percentage variance analysis

    All data is ENTIRELY SYNTHETIC.
*/

WITH -- Zone-level slot performance aggregation
zone_daily_performance AS (
    SELECT
        floor_zone,
        metric_date,
        day_of_week,
        day_type,

        -- Machine counts
        COUNT(DISTINCT machine_id) AS active_machines,

        -- Volume
        SUM(total_spins) AS zone_total_spins,
        SUM(jackpot_count) AS zone_jackpots,

        -- Revenue
        SUM(total_coin_in) AS zone_coin_in,
        SUM(total_coin_out) AS zone_coin_out,
        SUM(net_revenue) AS zone_net_revenue,

        -- Hold
        CASE
            WHEN SUM(total_coin_in) > 0
            THEN ROUND(SUM(net_revenue) / SUM(total_coin_in) * 100, 2)
            ELSE 0.0
        END AS zone_actual_hold_pct,

        -- Players
        SUM(unique_players) AS zone_unique_players,
        SUM(unique_sessions) AS zone_total_sessions,

        -- Utilization
        AVG(uptime_pct) AS avg_machine_uptime_pct,
        AVG(spins_per_hour) AS avg_spins_per_hour

    FROM {{ ref('slv_slot_performance') }}
    GROUP BY floor_zone, metric_date, day_of_week, day_type
),

-- Aggregate zone metrics over the analysis period
zone_summary AS (
    SELECT
        floor_zone,

        -- Time range
        MIN(metric_date) AS period_start,
        MAX(metric_date) AS period_end,
        COUNT(DISTINCT metric_date) AS active_days,

        -- Machine metrics
        AVG(active_machines) AS avg_machines_active,
        MAX(active_machines) AS peak_machines_active,

        -- Revenue metrics
        SUM(zone_net_revenue) AS total_revenue,
        AVG(zone_net_revenue) AS avg_daily_revenue,
        SUM(zone_coin_in) AS total_coin_in,

        -- Revenue per machine per day
        CASE
            WHEN SUM(active_machines) > 0 AND COUNT(DISTINCT metric_date) > 0
            THEN ROUND(SUM(zone_net_revenue) / (AVG(active_machines) * COUNT(DISTINCT metric_date)), 2)
            ELSE 0.0
        END AS revenue_per_machine_day,

        -- Hold percentage
        CASE
            WHEN SUM(zone_coin_in) > 0
            THEN ROUND(SUM(zone_net_revenue) / SUM(zone_coin_in) * 100, 2)
            ELSE 0.0
        END AS overall_hold_pct,

        -- Hold variance from target
        CASE
            WHEN SUM(zone_coin_in) > 0
            THEN ROUND(
                (SUM(zone_net_revenue) / SUM(zone_coin_in) * 100) - {{ var('target_hold_pct') }}, 2
            )
            ELSE NULL
        END AS hold_variance_from_target,

        -- Player metrics
        AVG(zone_unique_players) AS avg_daily_players,
        MAX(zone_unique_players) AS peak_daily_players,

        -- Utilization
        AVG(avg_machine_uptime_pct) AS avg_uptime_pct,
        AVG(avg_spins_per_hour) AS avg_spins_per_hour,

        -- Weekend vs weekday performance
        AVG(CASE WHEN day_type = 'WEEKEND' THEN zone_net_revenue END) AS avg_weekend_revenue,
        AVG(CASE WHEN day_type = 'WEEKDAY' THEN zone_net_revenue END) AS avg_weekday_revenue,

        -- Weekend lift
        CASE
            WHEN AVG(CASE WHEN day_type = 'WEEKDAY' THEN zone_net_revenue END) > 0
            THEN ROUND(
                (AVG(CASE WHEN day_type = 'WEEKEND' THEN zone_net_revenue END) -
                 AVG(CASE WHEN day_type = 'WEEKDAY' THEN zone_net_revenue END)) /
                AVG(CASE WHEN day_type = 'WEEKDAY' THEN zone_net_revenue END) * 100, 1
            )
            ELSE NULL
        END AS weekend_lift_pct,

        -- Jackpot frequency
        SUM(zone_jackpots) AS total_jackpots,
        CASE
            WHEN SUM(zone_total_spins) > 0
            THEN ROUND(SUM(zone_jackpots)::DECIMAL / SUM(zone_total_spins) * 10000, 2)
            ELSE 0.0
        END AS jackpots_per_10000_spins

    FROM zone_daily_performance
    GROUP BY floor_zone
),

-- Traffic pattern analysis from player sessions
traffic_patterns AS (
    SELECT
        floor_zone,
        day_of_week,
        time_of_day,
        COUNT(*) AS session_count,
        AVG(duration_minutes) AS avg_session_duration,
        AVG(coin_in) AS avg_coin_in
    FROM {{ ref('slv_player_sessions') }}
    WHERE floor_zone IS NOT NULL
    GROUP BY floor_zone, day_of_week, time_of_day
),

-- Peak traffic identification per zone
peak_traffic AS (
    SELECT
        floor_zone,
        -- Peak day
        FIRST_VALUE(day_of_week) OVER (
            PARTITION BY floor_zone ORDER BY session_count DESC
        ) AS peak_day_of_week,
        -- Peak time
        FIRST_VALUE(time_of_day) OVER (
            PARTITION BY floor_zone ORDER BY session_count DESC
        ) AS peak_time_of_day
    FROM traffic_patterns
    QUALIFY ROW_NUMBER() OVER (PARTITION BY floor_zone ORDER BY session_count DESC) = 1
),

-- Final optimization scoring
optimization AS (
    SELECT
        zs.floor_zone,

        -- Time range
        zs.period_start,
        zs.period_end,
        zs.active_days,

        -- Machine metrics
        ROUND(zs.avg_machines_active, 0) AS avg_machines_active,
        zs.peak_machines_active,

        -- Revenue metrics
        ROUND(zs.total_revenue, 2) AS total_revenue,
        ROUND(zs.avg_daily_revenue, 2) AS avg_daily_revenue,
        ROUND(zs.revenue_per_machine_day, 2) AS revenue_per_machine_day,

        -- Hold analysis
        zs.overall_hold_pct,
        zs.hold_variance_from_target,
        CASE
            WHEN ABS(COALESCE(zs.hold_variance_from_target, 0)) <= 1.0 THEN 'ON_TARGET'
            WHEN zs.hold_variance_from_target > 1.0 THEN 'ABOVE_TARGET'
            WHEN zs.hold_variance_from_target < -1.0 THEN 'BELOW_TARGET'
            ELSE 'UNKNOWN'
        END AS hold_status,

        -- Player occupancy
        ROUND(zs.avg_daily_players, 0) AS avg_daily_players,
        zs.peak_daily_players,

        -- Machine utilization
        ROUND(zs.avg_uptime_pct, 1) AS avg_machine_utilization_pct,
        ROUND(zs.avg_spins_per_hour, 0) AS avg_spins_per_hour,

        -- Day-of-week patterns
        ROUND(zs.avg_weekend_revenue, 2) AS avg_weekend_revenue,
        ROUND(zs.avg_weekday_revenue, 2) AS avg_weekday_revenue,
        zs.weekend_lift_pct,

        -- Peak traffic
        pt.peak_day_of_week,
        pt.peak_time_of_day,

        -- Jackpot frequency
        zs.total_jackpots,
        zs.jackpots_per_10000_spins,

        -- Optimization score (composite 0-100)
        -- Weighs: revenue/machine (40%), utilization (30%), hold accuracy (20%), growth (10%)
        ROUND(
            -- Revenue per machine score (normalized to 0-40)
            LEAST(zs.revenue_per_machine_day / 50.0 * 40, 40) +
            -- Utilization score (normalized to 0-30)
            LEAST(zs.avg_uptime_pct / 100.0 * 30, 30) +
            -- Hold accuracy score (closer to target = higher, 0-20)
            CASE
                WHEN ABS(COALESCE(zs.hold_variance_from_target, 99)) <= 0.5 THEN 20
                WHEN ABS(COALESCE(zs.hold_variance_from_target, 99)) <= 1.0 THEN 15
                WHEN ABS(COALESCE(zs.hold_variance_from_target, 99)) <= 2.0 THEN 10
                ELSE 5
            END +
            -- Weekend performance score (0-10)
            CASE WHEN COALESCE(zs.weekend_lift_pct, 0) > 30 THEN 10 WHEN COALESCE(zs.weekend_lift_pct, 0) > 15 THEN 7 ELSE 4 END
        , 1) AS optimization_score,

        -- Recommendation
        CASE
            WHEN zs.revenue_per_machine_day < 20 AND zs.avg_uptime_pct < 40 THEN 'REMOVE_MACHINES'
            WHEN zs.revenue_per_machine_day < 30 AND zs.avg_uptime_pct > 70 THEN 'CHANGE_DENOMINATION_MIX'
            WHEN zs.revenue_per_machine_day > 80 AND zs.avg_uptime_pct > 85 THEN 'ADD_MACHINES'
            WHEN ABS(COALESCE(zs.hold_variance_from_target, 0)) > 2.0 THEN 'REVIEW_PAR_SHEETS'
            ELSE 'MONITOR'
        END AS optimization_recommendation,

        -- Metadata
        CURRENT_DATE() AS reporting_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM zone_summary zs
    LEFT JOIN peak_traffic pt ON zs.floor_zone = pt.floor_zone
)

SELECT * FROM optimization
ORDER BY optimization_score DESC
