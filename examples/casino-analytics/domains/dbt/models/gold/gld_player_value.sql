{{ config(
    materialized='table',
    tags=['gold', 'player', 'lifetime_value', 'analytics']
) }}

/*
    Gold Layer — Player Lifetime Value Model

    Calculates comprehensive player value metrics including:
    - Total and average daily theoretical (ADT)
    - Visit frequency and trip value trends
    - Churn probability scoring based on recency/frequency/monetary
    - Tier progression tracking
    - Comp efficiency analysis (comps issued vs theo generated)

    Used by player development hosts and marketing for targeted offers.
    All data is ENTIRELY SYNTHETIC.
*/

WITH -- Aggregate player session history
player_session_summary AS (
    SELECT
        player_id,

        -- Volume metrics
        COUNT(*) AS total_sessions,
        COUNT(DISTINCT session_date) AS total_visit_days,

        -- Time range
        MIN(session_date) AS first_visit_date,
        MAX(session_date) AS last_visit_date,
        DATEDIFF(CURRENT_DATE(), MAX(session_date)) AS days_since_last_visit,
        DATEDIFF(MAX(session_date), MIN(session_date)) AS player_tenure_days,

        -- Financial metrics
        SUM(coin_in) AS lifetime_coin_in,
        SUM(coin_out) AS lifetime_coin_out,
        SUM(session_theoretical) AS lifetime_theoretical,
        SUM(net_result) AS lifetime_net_result,

        -- Averages
        AVG(coin_in) AS avg_session_coin_in,
        AVG(session_theoretical) AS avg_session_theoretical,
        AVG(duration_minutes) AS avg_session_duration,

        -- Trip metrics (per visit day)
        SUM(coin_in) / NULLIF(COUNT(DISTINCT session_date), 0) AS avg_trip_coin_in,
        SUM(session_theoretical) / NULLIF(COUNT(DISTINCT session_date), 0) AS avg_trip_theoretical,

        -- Visit frequency (visits per 30-day period)
        CASE
            WHEN DATEDIFF(MAX(session_date), MIN(session_date)) > 0
            THEN COUNT(DISTINCT session_date)::DECIMAL / (DATEDIFF(MAX(session_date), MIN(session_date)) / 30.0)
            ELSE COUNT(DISTINCT session_date)
        END AS visits_per_month,

        -- Session characteristics
        AVG(session_hold_pct) AS avg_hold_pct,
        MAX(session_rating) AS max_session_rating,
        ROUND(AVG(session_rating), 1) AS avg_session_rating,

        -- Game preferences
        MODE(game_type) AS preferred_game_type,
        MODE(denomination) AS preferred_denomination,
        MODE(floor_zone) AS preferred_zone,
        MODE(time_of_day) AS preferred_time,
        MODE(day_type) AS preferred_day_type,

        -- Recent activity (last 30 days)
        COUNT(CASE WHEN session_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN 1 END) AS sessions_last_30d,
        SUM(CASE WHEN session_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN session_theoretical ELSE 0 END) AS theo_last_30d,

        -- Trend: last 30 days vs prior 30 days
        SUM(CASE WHEN session_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN coin_in ELSE 0 END) AS coin_in_last_30d,
        SUM(CASE WHEN session_date BETWEEN DATEADD(DAY, -60, CURRENT_DATE()) AND DATEADD(DAY, -31, CURRENT_DATE()) THEN coin_in ELSE 0 END) AS coin_in_prior_30d

    FROM {{ ref('slv_player_sessions') }}
    GROUP BY player_id
),

-- F&B comp history
player_comps AS (
    SELECT
        player_id,
        COUNT(*) AS total_fnb_visits,
        SUM(total) AS total_fnb_spend,
        SUM(comp_value) AS total_comp_value,
        AVG(total) AS avg_check_amount,
        AVG(CASE WHEN is_comp THEN 1.0 ELSE 0.0 END) * 100 AS comp_frequency_pct,
        MODE(venue) AS preferred_venue,
        MODE(meal_period) AS preferred_meal_period
    FROM {{ ref('slv_fnb_analytics') }}
    WHERE is_rated_guest = TRUE
    GROUP BY player_id
),

-- Calculate player value and churn scores
player_value AS (
    SELECT
        ps.player_id,

        -- Visit metrics
        ps.total_sessions,
        ps.total_visit_days,
        ps.first_visit_date,
        ps.last_visit_date,
        ps.days_since_last_visit,
        ps.player_tenure_days,
        ROUND(ps.visits_per_month, 2) AS visits_per_month,

        -- Financial metrics
        ROUND(ps.lifetime_coin_in, 2) AS lifetime_coin_in,
        ROUND(ps.lifetime_coin_out, 2) AS lifetime_coin_out,
        ROUND(ps.lifetime_theoretical, 2) AS lifetime_theoretical,
        ROUND(ps.lifetime_net_result, 2) AS lifetime_net_result,

        -- ADT (Average Daily Theoretical)
        CASE
            WHEN ps.total_visit_days > 0
            THEN ROUND(ps.lifetime_theoretical / ps.total_visit_days, 2)
            ELSE 0.0
        END AS adt,

        -- Trip metrics
        ROUND(ps.avg_trip_coin_in, 2) AS avg_trip_coin_in,
        ROUND(ps.avg_trip_theoretical, 2) AS avg_trip_theoretical,
        ROUND(ps.avg_session_duration, 0) AS avg_session_minutes,

        -- Tier assignment based on ADT
        CASE
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= {{ var('tier_thresholds')['diamond'] }} THEN 'DIAMOND'
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= {{ var('tier_thresholds')['platinum'] }} THEN 'PLATINUM'
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= {{ var('tier_thresholds')['gold'] }} THEN 'GOLD'
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= {{ var('tier_thresholds')['silver'] }} THEN 'SILVER'
            ELSE 'BRONZE'
        END AS calculated_tier,

        -- Churn probability scoring (RFM-based)
        -- Recency score (0-100, higher = more recent)
        CASE
            WHEN ps.days_since_last_visit <= 7 THEN 100
            WHEN ps.days_since_last_visit <= 14 THEN 85
            WHEN ps.days_since_last_visit <= 30 THEN 70
            WHEN ps.days_since_last_visit <= 45 THEN 50
            WHEN ps.days_since_last_visit <= 60 THEN 30
            WHEN ps.days_since_last_visit <= 90 THEN 15
            ELSE 5
        END AS recency_score,

        -- Frequency score (0-100, higher = more frequent)
        CASE
            WHEN ps.visits_per_month >= 8 THEN 100
            WHEN ps.visits_per_month >= 4 THEN 85
            WHEN ps.visits_per_month >= 2 THEN 70
            WHEN ps.visits_per_month >= 1 THEN 55
            WHEN ps.visits_per_month >= 0.5 THEN 35
            ELSE 15
        END AS frequency_score,

        -- Monetary score (0-100, higher = higher value)
        CASE
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= 1500 THEN 100
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= 400 THEN 85
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= 150 THEN 70
            WHEN ps.lifetime_theoretical / NULLIF(ps.total_visit_days, 0) >= 50 THEN 50
            ELSE 25
        END AS monetary_score,

        -- Overall churn probability (inverse of engagement)
        -- Higher score = MORE likely to churn
        ROUND(100 - (
            CASE WHEN ps.days_since_last_visit <= 7 THEN 100 WHEN ps.days_since_last_visit <= 14 THEN 85 WHEN ps.days_since_last_visit <= 30 THEN 70 WHEN ps.days_since_last_visit <= 45 THEN 50 WHEN ps.days_since_last_visit <= 60 THEN 30 WHEN ps.days_since_last_visit <= 90 THEN 15 ELSE 5 END * 0.5 +
            CASE WHEN ps.visits_per_month >= 8 THEN 100 WHEN ps.visits_per_month >= 4 THEN 85 WHEN ps.visits_per_month >= 2 THEN 70 WHEN ps.visits_per_month >= 1 THEN 55 WHEN ps.visits_per_month >= 0.5 THEN 35 ELSE 15 END * 0.3 +
            CASE WHEN ps.coin_in_last_30d > 0 AND ps.coin_in_prior_30d > 0 AND ps.coin_in_last_30d >= ps.coin_in_prior_30d * 0.8 THEN 80 WHEN ps.coin_in_last_30d > 0 THEN 50 ELSE 10 END * 0.2
        ) / 100.0, 1) AS churn_probability_score,

        -- Activity trend
        CASE
            WHEN ps.coin_in_last_30d > ps.coin_in_prior_30d * 1.1 THEN 'INCREASING'
            WHEN ps.coin_in_last_30d < ps.coin_in_prior_30d * 0.9 THEN 'DECREASING'
            WHEN ps.coin_in_last_30d = 0 AND ps.coin_in_prior_30d = 0 THEN 'DORMANT'
            ELSE 'STABLE'
        END AS activity_trend,

        -- Preferences
        ps.preferred_game_type,
        ps.preferred_denomination,
        ps.preferred_zone,
        ps.preferred_time,
        ps.preferred_day_type,

        -- Comp analysis
        COALESCE(pc.total_fnb_visits, 0) AS total_fnb_visits,
        ROUND(COALESCE(pc.total_comp_value, 0), 2) AS total_comp_value,
        ROUND(COALESCE(pc.avg_check_amount, 0), 2) AS avg_fnb_check,

        -- Comp efficiency (comp value / theoretical win — should be < 40%)
        CASE
            WHEN ps.lifetime_theoretical > 0
            THEN ROUND(COALESCE(pc.total_comp_value, 0) / ps.lifetime_theoretical * 100, 1)
            ELSE 0.0
        END AS comp_efficiency_pct,

        pc.preferred_venue,
        pc.preferred_meal_period,

        -- Metadata
        CURRENT_DATE() AS reporting_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM player_session_summary ps
    LEFT JOIN player_comps pc ON ps.player_id = pc.player_id
)

SELECT * FROM player_value
ORDER BY lifetime_theoretical DESC
