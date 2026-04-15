{{ config(
    materialized='table',
    tags=['gold', 'transit', 'dashboard', 'analytics']
) }}

/*
    Gold Layer: Transit Performance Dashboard
    Description: Agency-level and route-level transit performance KPIs for
                 executive dashboards. Includes on-time rates, ridership trends,
                 service reliability, mode comparison, and peer benchmarking.

    Business Use Cases:
      - Monitor agency performance against FTA service targets
      - Compare transit modes (bus vs rail vs demand-response)
      - Identify routes with declining ridership or reliability
      - Support Title 49 transit performance reporting
      - Dashboard data for transit operations center
*/

WITH transit_base AS (
    SELECT
        transit_sk,
        agency_id,
        agency_name,
        city,
        state_code,
        urbanized_area_name,
        urbanized_area_population,
        mode_code,
        mode_name_standard,
        mode_category,
        route_id,
        route_name,
        report_date,
        report_year,
        report_month,
        scheduled_trips,
        actual_trips,
        on_time_trips,
        missed_trips,
        on_time_rate_pct,
        service_delivery_rate_pct,
        ridership,
        passenger_miles,
        vehicle_revenue_hours,
        vehicle_revenue_miles,
        ridership_per_vehicle_hour,
        avg_speed_mph,
        fleet_utilization_pct,
        vehicles_operated_max_service,
        total_fleet_vehicles,
        avg_fleet_age_years,
        safety_incidents,
        fatalities,
        injuries,
        operating_expense,
        fare_revenue,
        cost_per_trip,
        farebox_recovery_pct,
        service_reliability_index,
        reliability_category
    FROM {{ ref('slv_transit_performance') }}
    WHERE report_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years') }}
),

-- Monthly agency-level aggregation by mode
agency_monthly AS (
    SELECT
        agency_id,
        agency_name,
        city,
        state_code,
        urbanized_area_name,
        urbanized_area_population,
        mode_name_standard,
        mode_category,
        report_year,
        report_month,
        report_date,

        -- Service metrics
        SUM(scheduled_trips) AS total_scheduled_trips,
        SUM(actual_trips) AS total_actual_trips,
        SUM(on_time_trips) AS total_on_time_trips,
        SUM(missed_trips) AS total_missed_trips,

        -- On-time rate
        CASE
            WHEN SUM(actual_trips) > 0
            THEN ROUND(SUM(on_time_trips) * 100.0 / SUM(actual_trips), 2)
            ELSE NULL
        END AS avg_on_time_rate,

        -- Service delivery rate
        CASE
            WHEN SUM(scheduled_trips) > 0
            THEN ROUND(SUM(actual_trips) * 100.0 / SUM(scheduled_trips), 2)
            ELSE NULL
        END AS avg_service_delivery_rate,

        -- Ridership
        SUM(ridership) AS total_ridership,
        SUM(passenger_miles) AS total_passenger_miles,

        -- Vehicle utilization
        SUM(vehicle_revenue_hours) AS total_vehicle_revenue_hours,
        SUM(vehicle_revenue_miles) AS total_vehicle_revenue_miles,
        SUM(vehicles_operated_max_service) AS total_vehicles_operated,

        -- Ridership per vehicle hour
        CASE
            WHEN SUM(vehicle_revenue_hours) > 0
            THEN ROUND(SUM(ridership)::DECIMAL / SUM(vehicle_revenue_hours), 2)
            ELSE NULL
        END AS ridership_per_vehicle_hour,

        -- Safety
        SUM(COALESCE(safety_incidents, 0)) AS total_safety_incidents,
        SUM(COALESCE(fatalities, 0)) AS total_fatalities,
        SUM(COALESCE(injuries, 0)) AS total_injuries,

        -- Financials
        SUM(COALESCE(operating_expense, 0)) AS total_operating_expense,
        SUM(COALESCE(fare_revenue, 0)) AS total_fare_revenue,

        -- Cost efficiency
        CASE
            WHEN SUM(ridership) > 0
            THEN ROUND(SUM(COALESCE(operating_expense, 0))::DECIMAL / SUM(ridership), 2)
            ELSE NULL
        END AS cost_per_trip,

        -- Farebox recovery
        CASE
            WHEN SUM(COALESCE(operating_expense, 0)) > 0
            THEN ROUND(SUM(COALESCE(fare_revenue, 0)) * 100.0 / SUM(COALESCE(operating_expense, 0)), 2)
            ELSE NULL
        END AS farebox_recovery_pct,

        -- Service reliability index (weighted average)
        ROUND(AVG(service_reliability_index), 2) AS avg_service_reliability_index,

        -- Count distinct routes for context
        COUNT(DISTINCT route_id) AS routes_served

    FROM transit_base
    GROUP BY
        agency_id, agency_name, city, state_code, urbanized_area_name,
        urbanized_area_population, mode_name_standard, mode_category,
        report_year, report_month, report_date
),

-- Calculate trends (year-over-year)
with_trends AS (
    SELECT
        am.*,

        -- Previous year same month ridership for YoY comparison
        LAG(total_ridership, 12) OVER (
            PARTITION BY agency_id, mode_name_standard
            ORDER BY report_year, report_month
        ) AS ridership_same_month_prev_year,

        -- Previous year same month on-time rate
        LAG(avg_on_time_rate, 12) OVER (
            PARTITION BY agency_id, mode_name_standard
            ORDER BY report_year, report_month
        ) AS on_time_rate_same_month_prev_year,

        -- Rolling 12-month ridership for trend
        SUM(total_ridership) OVER (
            PARTITION BY agency_id, mode_name_standard
            ORDER BY report_year, report_month
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) AS ridership_rolling_12m,

        -- Previous 12-month ridership (for YoY rolling)
        SUM(total_ridership) OVER (
            PARTITION BY agency_id, mode_name_standard
            ORDER BY report_year, report_month
            ROWS BETWEEN 23 PRECEDING AND 12 PRECEDING
        ) AS ridership_rolling_12m_prev,

        -- Rolling 12-month average on-time rate
        AVG(avg_on_time_rate) OVER (
            PARTITION BY agency_id, mode_name_standard
            ORDER BY report_year, report_month
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) AS on_time_rate_rolling_12m_avg

    FROM agency_monthly am
),

-- Final output with derived trend indicators
final AS (
    SELECT
        -- Identifiers
        agency_id,
        agency_name,
        city,
        state_code,
        urbanized_area_name,
        urbanized_area_population,
        mode_name_standard AS mode,
        mode_category,
        report_year,
        report_month,
        report_date AS report_month_date,

        -- Service metrics
        total_scheduled_trips,
        total_actual_trips,
        total_on_time_trips,
        ROUND(avg_on_time_rate, 1) AS avg_on_time_rate,
        ROUND(avg_service_delivery_rate, 1) AS avg_service_delivery_rate,

        -- On-time target comparison
        CASE
            WHEN avg_on_time_rate >= {{ var('on_time_target_pct') }} THEN 'MEETING_TARGET'
            WHEN avg_on_time_rate >= {{ var('on_time_target_pct') }} - 10 THEN 'NEAR_TARGET'
            ELSE 'BELOW_TARGET'
        END AS on_time_target_status,

        -- Ridership
        total_ridership,
        total_passenger_miles,
        ridership_per_vehicle_hour,

        -- Vehicle utilization
        total_vehicle_revenue_hours,
        total_vehicle_revenue_miles,
        total_vehicles_operated,
        routes_served,

        -- Financials
        total_operating_expense,
        total_fare_revenue,
        cost_per_trip,
        ROUND(farebox_recovery_pct, 1) AS farebox_recovery_pct,

        -- Service reliability
        ROUND(avg_service_reliability_index, 1) AS service_reliability_index,

        -- Safety
        total_safety_incidents,
        total_fatalities,
        total_injuries,

        -- Year-over-year ridership change
        CASE
            WHEN ridership_same_month_prev_year IS NOT NULL AND ridership_same_month_prev_year > 0
            THEN ROUND(
                (total_ridership - ridership_same_month_prev_year) * 100.0
                / ridership_same_month_prev_year
            , 1)
            ELSE NULL
        END AS ridership_yoy_change_pct,

        -- Rolling 12-month ridership trend
        CASE
            WHEN ridership_rolling_12m_prev IS NOT NULL AND ridership_rolling_12m_prev > 0
            THEN ROUND(
                (ridership_rolling_12m - ridership_rolling_12m_prev) * 100.0
                / ridership_rolling_12m_prev
            , 1)
            ELSE NULL
        END AS ridership_rolling_yoy_change_pct,

        -- Trend classifications
        CASE
            WHEN ridership_rolling_12m_prev IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN ridership_rolling_12m > ridership_rolling_12m_prev * 1.05 THEN 'GROWING'
            WHEN ridership_rolling_12m < ridership_rolling_12m_prev * 0.95 THEN 'DECLINING'
            ELSE 'STABLE'
        END AS ridership_trend,

        CASE
            WHEN on_time_rate_same_month_prev_year IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN avg_on_time_rate > on_time_rate_same_month_prev_year + 2 THEN 'IMPROVING'
            WHEN avg_on_time_rate < on_time_rate_same_month_prev_year - 2 THEN 'DECLINING'
            ELSE 'STABLE'
        END AS on_time_trend,

        -- Rolling averages
        ROUND(on_time_rate_rolling_12m_avg, 1) AS on_time_rate_12m_avg,
        ridership_rolling_12m AS ridership_12m_total,

        -- Peer ranking within mode category
        ROW_NUMBER() OVER (
            PARTITION BY mode_category, report_year, report_month
            ORDER BY total_ridership DESC
        ) AS ridership_rank_in_mode,

        ROW_NUMBER() OVER (
            PARTITION BY mode_category, report_year, report_month
            ORDER BY avg_on_time_rate DESC NULLS LAST
        ) AS on_time_rank_in_mode,

        -- Overall agency performance grade
        CASE
            WHEN avg_on_time_rate >= 90 AND avg_service_delivery_rate >= 98
                 AND farebox_recovery_pct >= 30 THEN 'A'
            WHEN avg_on_time_rate >= 80 AND avg_service_delivery_rate >= 95
                 AND farebox_recovery_pct >= 20 THEN 'B'
            WHEN avg_on_time_rate >= 70 AND avg_service_delivery_rate >= 90 THEN 'C'
            WHEN avg_on_time_rate >= 60 THEN 'D'
            ELSE 'F'
        END AS performance_grade,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM with_trends
)

SELECT * FROM final
ORDER BY report_year DESC, report_month DESC, total_ridership DESC
