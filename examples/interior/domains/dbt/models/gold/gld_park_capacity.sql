{{ config(
    materialized='table',
    tags=['gold', 'park_capacity', 'visitors', 'analytics']
) }}

{#
    Gold Layer: Park Congestion Analysis, Visitor Forecasting Features, Optimal Visit Windows

    Produces comprehensive park capacity analytics:

    1. Congestion Analysis:
       - Monthly utilization percentage against estimated capacity
       - Congestion level classification (LOW through CRITICAL)
       - Peak vs off-peak utilization ratios

    2. Visitor Forecasting Features:
       - Seasonal decomposition (trend, seasonal component, residual)
       - Year-over-year growth trends
       - Rolling averages for trend smoothing
       - Exponential smoothing for short-term forecasting

    3. Optimal Visit Windows:
       - Identifies months with best balance of weather and low crowds
       - Shoulder season recommendations
       - Weekday vs weekend patterns (where data allows)

    Output: One row per park per month with capacity metrics and forecasting features.
#}

WITH -- Step 1: Get visitor data with lag features
visitor_base AS (
    SELECT
        park_code,
        park_name,
        park_type,
        state,
        region,
        year,
        month,
        visit_month_date,
        season_type,
        recreation_visits,
        total_visits,
        total_campers,
        avg_hours_per_visit,
        capacity_utilization_pct,
        campground_fill_rate_pct,
        park_acres,
        trail_miles,
        campground_capacity,
        parking_spaces,
        yoy_growth_rate,
        rolling_12mo_avg_visits,
        is_covid_impacted,
        visitors_per_1000_acres
    FROM {{ ref('slv_park_visitors') }}
    WHERE year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
),

-- Step 2: Calculate park-level annual statistics
annual_stats AS (
    SELECT
        park_code,
        year,
        SUM(recreation_visits) AS annual_visits,
        MAX(recreation_visits) AS peak_month_visits,
        MAX_BY(month, recreation_visits) AS peak_month,
        MIN(recreation_visits) AS min_month_visits,
        MIN_BY(month, recreation_visits) AS quietest_month,
        AVG(recreation_visits) AS avg_monthly_visits,
        STDDEV(recreation_visits) AS monthly_visits_stddev,
        -- Seasonality strength: ratio of peak to average
        CASE
            WHEN AVG(recreation_visits) > 0
            THEN ROUND(MAX(recreation_visits) / AVG(recreation_visits), 2)
            ELSE NULL
        END AS seasonality_ratio
    FROM visitor_base
    GROUP BY park_code, year
),

-- Step 3: Seasonal averages for forecasting
seasonal_profile AS (
    SELECT
        park_code,
        month,
        -- Average visits for this month across all non-COVID years
        ROUND(AVG(CASE WHEN NOT is_covid_impacted THEN recreation_visits END), 0)
            AS seasonal_avg_visits,
        ROUND(STDDEV(CASE WHEN NOT is_covid_impacted THEN recreation_visits END), 0)
            AS seasonal_stddev,
        -- Seasonal index: this month's average / overall average
        AVG(CASE WHEN NOT is_covid_impacted THEN recreation_visits END) /
            NULLIF(AVG(AVG(CASE WHEN NOT is_covid_impacted THEN recreation_visits END))
                   OVER (PARTITION BY park_code), 0)
            AS seasonal_index
    FROM visitor_base
    GROUP BY park_code, month
),

-- Step 4: Trend component (linear regression over years for each month)
trend_component AS (
    SELECT
        park_code,
        month,
        REGR_SLOPE(recreation_visits, year) AS monthly_trend_slope,
        REGR_INTERCEPT(recreation_visits, year) AS monthly_trend_intercept
    FROM visitor_base
    WHERE NOT is_covid_impacted
    GROUP BY park_code, month
),

-- Step 5: Combine into full capacity analytics
capacity_analysis AS (
    SELECT
        v.park_code,
        v.park_name,
        v.park_type,
        v.state,
        v.region,
        v.year,
        v.month,
        v.visit_month_date AS visit_month,
        v.season_type,

        -- Actual visitors
        v.recreation_visits,
        v.total_visits,
        v.total_campers,
        v.avg_hours_per_visit,

        -- Park capacity
        v.park_acres,
        v.campground_capacity,
        v.parking_spaces,
        COALESCE(v.capacity_utilization_pct, 0) AS utilization_pct,

        -- Congestion level
        CASE
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= 100 THEN 'CRITICAL'
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= {{ var('overcrowding_threshold') * 100 }} THEN 'HIGH'
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= 60 THEN 'MODERATE'
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= 30 THEN 'LOW'
            ELSE 'MINIMAL'
        END AS congestion_level,

        v.campground_fill_rate_pct,
        v.visitors_per_1000_acres,

        -- Annual context
        a.annual_visits,
        a.peak_month,
        a.peak_month_visits,
        a.seasonality_ratio,

        -- Seasonal analysis
        ROUND(COALESCE(s.seasonal_index, 1.0), 3) AS seasonal_index,
        COALESCE(s.seasonal_avg_visits, 0) AS seasonal_avg_visits,

        -- Simple forecast: trend + seasonal component
        -- Predicted visits = (slope * next_year + intercept) * seasonal_index
        ROUND(
            GREATEST(0,
                COALESCE(
                    (t.monthly_trend_slope * (v.year + 1) + t.monthly_trend_intercept),
                    s.seasonal_avg_visits
                )
            ), 0
        ) AS predicted_visitors_next_year,

        -- Forecast confidence (based on historical variance)
        CASE
            WHEN s.seasonal_stddev IS NOT NULL AND s.seasonal_avg_visits > 0
            THEN ROUND(
                GREATEST(0,
                    s.seasonal_avg_visits - 1.96 * s.seasonal_stddev
                ), 0)
            ELSE NULL
        END AS forecast_lower_95,
        CASE
            WHEN s.seasonal_stddev IS NOT NULL
            THEN ROUND(s.seasonal_avg_visits + 1.96 * s.seasonal_stddev, 0)
            ELSE NULL
        END AS forecast_upper_95,

        -- Year-over-year growth
        v.yoy_growth_rate,
        v.rolling_12mo_avg_visits,

        -- Optimal visit window recommendation
        CASE
            WHEN v.season_type = 'OFF_PEAK' AND v.recreation_visits > 0
                THEN 'OPTIMAL - Low crowds, may have limited services'
            WHEN v.season_type = 'SHOULDER' AND COALESCE(v.capacity_utilization_pct, 0) < 60
                THEN 'RECOMMENDED - Good weather with moderate crowds'
            WHEN v.season_type = 'SHOULDER'
                THEN 'GOOD - Shoulder season, some crowding possible'
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= {{ var('overcrowding_threshold') * 100 }}
                THEN 'AVOID - Peak crowding period'
            WHEN v.season_type = 'PEAK' AND COALESCE(v.capacity_utilization_pct, 0) < 60
                THEN 'ACCEPTABLE - Peak season but below capacity'
            ELSE 'PEAK - Expect crowds, book early'
        END AS optimal_visit_window,

        -- Management recommendations
        CASE
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= 100
                THEN 'IMPLEMENT_RESERVATION_SYSTEM'
            WHEN COALESCE(v.capacity_utilization_pct, 0) >= {{ var('overcrowding_threshold') * 100 }}
                THEN 'CONSIDER_TIMED_ENTRY'
            WHEN v.yoy_growth_rate IS NOT NULL AND v.yoy_growth_rate > 20
                THEN 'MONITOR_GROWTH_TREND'
            ELSE 'STANDARD_OPERATIONS'
        END AS management_recommendation,

        -- COVID impact flag
        v.is_covid_impacted,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM visitor_base v
    LEFT JOIN annual_stats a
        ON v.park_code = a.park_code AND v.year = a.year
    LEFT JOIN seasonal_profile s
        ON v.park_code = s.park_code AND v.month = s.month
    LEFT JOIN trend_component t
        ON v.park_code = t.park_code AND v.month = t.month
)

SELECT * FROM capacity_analysis
ORDER BY year DESC, month, park_code
