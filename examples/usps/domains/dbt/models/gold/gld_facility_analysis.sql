{{ config(
    materialized='table',
    tags=['gold', 'facility', 'analysis', 'analytics']
) }}

/*
    Gold Layer: Facility Consolidation Analysis
    Description: Processing facility utilization analysis with consolidation
                 scoring. Evaluates facilities based on throughput utilization,
                 geographic overlap with nearby facilities, cost efficiency,
                 and spare capacity to identify consolidation candidates.

    Business Use Cases:
      - Identify underutilized facilities for potential consolidation
      - Evaluate geographic overlap between processing plants
      - Optimize facility network for cost and coverage
      - Support long-range infrastructure planning
*/

WITH facility_base AS (
    SELECT
        facility_sk,
        facility_id,
        facility_name,
        facility_type,
        city,
        state,
        zip_code,
        district,
        area,
        region,
        latitude,
        longitude,
        report_date,
        report_year,
        report_month,
        is_business_day,
        max_throughput_daily,
        actual_throughput_daily,
        utilization_pct,
        utilization_category,
        letters_processed,
        flats_processed,
        parcels_processed,
        total_pieces_processed,
        sorting_machines,
        sorting_machines_active,
        sorting_machine_utilization_pct,
        delivery_vehicles,
        delivery_vehicles_active,
        vehicle_utilization_pct,
        total_employees,
        carriers,
        pieces_per_employee,
        operating_hours,
        overtime_pct,
        operating_cost_daily,
        revenue_daily,
        cost_per_piece,
        revenue_per_piece,
        square_footage,
        year_built,
        facility_age_years,
        delivery_routes
    FROM {{ ref('slv_facility_operations') }}
    WHERE report_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years') }}
),

-- Latest month aggregation per facility
facility_current AS (
    SELECT
        facility_id,
        facility_name,
        facility_type,
        city,
        state,
        zip_code,
        district,
        region,
        latitude,
        longitude,

        -- Use most recent reporting period
        MAX(report_date) AS latest_report_date,

        -- Average utilization over last 30 days
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN utilization_pct END), 1)
            AS current_utilization_pct,

        -- Average throughput
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN actual_throughput_daily END), 0)
            AS avg_daily_throughput,
        MAX(max_throughput_daily) AS max_throughput_daily,

        -- Spare capacity
        ROUND(AVG(CASE
            WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE())
                 AND max_throughput_daily > 0
            THEN max_throughput_daily - COALESCE(actual_throughput_daily, 0)
            ELSE NULL
        END), 0) AS avg_daily_spare_capacity,

        -- Volume breakdown
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN letters_processed END), 0) AS avg_letters,
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN parcels_processed END), 0) AS avg_parcels,
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN total_pieces_processed END), 0) AS avg_total_pieces,

        -- Equipment
        MAX(sorting_machines) AS sorting_machines,
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN sorting_machine_utilization_pct END), 1)
            AS avg_machine_utilization_pct,
        MAX(delivery_vehicles) AS delivery_vehicles,

        -- Staffing
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN total_employees END), 0) AS avg_employees,
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN pieces_per_employee END), 0) AS avg_pieces_per_employee,

        -- Cost efficiency
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN cost_per_piece END), 4) AS avg_cost_per_piece,
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN operating_cost_daily END), 2) AS avg_daily_cost,
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN revenue_daily END), 2) AS avg_daily_revenue,

        -- Overtime indicator
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN overtime_pct END), 1) AS avg_overtime_pct,

        -- Facility characteristics
        MAX(square_footage) AS square_footage,
        MAX(year_built) AS year_built,
        MAX(facility_age_years) AS facility_age_years,
        MAX(delivery_routes) AS delivery_routes,

        -- Utilization trend (compare last 30 days vs. prior 30 days)
        ROUND(AVG(CASE WHEN report_date >= DATEADD(DAY, -30, CURRENT_DATE()) THEN utilization_pct END), 1)
        - ROUND(AVG(CASE
            WHEN report_date >= DATEADD(DAY, -60, CURRENT_DATE())
                 AND report_date < DATEADD(DAY, -30, CURRENT_DATE())
            THEN utilization_pct END), 1)
        AS utilization_trend_30d

    FROM facility_base
    GROUP BY facility_id, facility_name, facility_type, city, state, zip_code,
             district, region, latitude, longitude
),

-- Calculate nearest facility distance (for consolidation analysis)
-- Using Haversine approximation: 1 degree lat ~ 69 miles
nearest_facility AS (
    SELECT
        a.facility_id,
        MIN(
            SQRT(
                POWER((a.latitude - b.latitude) * 69, 2)
                + POWER((a.longitude - b.longitude) * 69 * COS(RADIANS(a.latitude)), 2)
            )
        ) AS nearest_facility_miles,
        -- Get the ID of the nearest facility
        FIRST_VALUE(b.facility_id) OVER (
            PARTITION BY a.facility_id
            ORDER BY SQRT(
                POWER((a.latitude - b.latitude) * 69, 2)
                + POWER((a.longitude - b.longitude) * 69 * COS(RADIANS(a.latitude)), 2)
            ) ASC
        ) AS nearest_facility_id,
        FIRST_VALUE(b.current_utilization_pct) OVER (
            PARTITION BY a.facility_id
            ORDER BY SQRT(
                POWER((a.latitude - b.latitude) * 69, 2)
                + POWER((a.longitude - b.longitude) * 69 * COS(RADIANS(a.latitude)), 2)
            ) ASC
        ) AS nearest_facility_utilization_pct,
        FIRST_VALUE(b.avg_daily_spare_capacity) OVER (
            PARTITION BY a.facility_id
            ORDER BY SQRT(
                POWER((a.latitude - b.latitude) * 69, 2)
                + POWER((a.longitude - b.longitude) * 69 * COS(RADIANS(a.latitude)), 2)
            ) ASC
        ) AS nearest_facility_spare_capacity
    FROM facility_current a
    JOIN facility_current b
        ON a.facility_id != b.facility_id
        AND a.facility_type = b.facility_type
        AND a.latitude IS NOT NULL AND b.latitude IS NOT NULL
    GROUP BY a.facility_id, b.facility_id, a.latitude, a.longitude,
             b.latitude, b.longitude, b.current_utilization_pct, b.avg_daily_spare_capacity
),

nearest_deduped AS (
    SELECT DISTINCT
        facility_id,
        FIRST_VALUE(nearest_facility_miles) OVER (PARTITION BY facility_id ORDER BY nearest_facility_miles) AS nearest_facility_miles,
        FIRST_VALUE(nearest_facility_id) OVER (PARTITION BY facility_id ORDER BY nearest_facility_miles) AS nearest_facility_id,
        FIRST_VALUE(nearest_facility_utilization_pct) OVER (PARTITION BY facility_id ORDER BY nearest_facility_miles) AS nearest_facility_utilization_pct,
        FIRST_VALUE(nearest_facility_spare_capacity) OVER (PARTITION BY facility_id ORDER BY nearest_facility_miles) AS nearest_facility_spare_capacity
    FROM nearest_facility
),

-- Consolidation scoring
consolidation_analysis AS (
    SELECT
        fc.*,
        nd.nearest_facility_miles,
        nd.nearest_facility_id,
        nd.nearest_facility_utilization_pct,
        nd.nearest_facility_spare_capacity,

        -- Spare capacity percentage at nearest facility
        CASE
            WHEN nd.nearest_facility_utilization_pct IS NOT NULL
            THEN ROUND(100 - nd.nearest_facility_utilization_pct, 1)
            ELSE NULL
        END AS nearest_facility_spare_capacity_pct,

        -- Consolidation Score (0-100): higher = better consolidation candidate
        ROUND(
            -- Underutilization (35%): lower utilization = higher consolidation potential
            (CASE
                WHEN fc.current_utilization_pct IS NULL THEN 25
                WHEN fc.current_utilization_pct < 20 THEN 100
                WHEN fc.current_utilization_pct < 30 THEN 85
                WHEN fc.current_utilization_pct < {{ var('underutilized_threshold_pct') }} THEN 70
                WHEN fc.current_utilization_pct < 60 THEN 45
                WHEN fc.current_utilization_pct < 70 THEN 25
                ELSE 5
            END * 0.35)

            -- Proximity to another facility (25%): closer = easier to consolidate
            + (CASE
                WHEN nd.nearest_facility_miles IS NULL THEN 10
                WHEN nd.nearest_facility_miles <= 20 THEN 100
                WHEN nd.nearest_facility_miles <= {{ var('consolidation_distance_miles') }} THEN 75
                WHEN nd.nearest_facility_miles <= 100 THEN 40
                ELSE 10
            END * 0.25)

            -- Neighbor has spare capacity (25%): capacity to absorb volume
            + (CASE
                WHEN nd.nearest_facility_spare_capacity IS NULL THEN 20
                WHEN nd.nearest_facility_spare_capacity >= COALESCE(fc.avg_daily_throughput, 0) THEN 100
                WHEN nd.nearest_facility_spare_capacity >= COALESCE(fc.avg_daily_throughput, 0) * 0.75 THEN 75
                WHEN nd.nearest_facility_spare_capacity >= COALESCE(fc.avg_daily_throughput, 0) * 0.5 THEN 50
                ELSE 15
            END * 0.25)

            -- Cost efficiency (15%): higher cost per piece = more to gain
            + (CASE
                WHEN fc.avg_cost_per_piece IS NULL THEN 30
                WHEN fc.avg_cost_per_piece > 0.50 THEN 100
                WHEN fc.avg_cost_per_piece > 0.30 THEN 70
                WHEN fc.avg_cost_per_piece > 0.15 THEN 40
                ELSE 15
            END * 0.15)
        , 1) AS consolidation_score

    FROM facility_current fc
    LEFT JOIN nearest_deduped nd ON fc.facility_id = nd.facility_id
),

-- Final output
final AS (
    SELECT
        -- Identifiers
        facility_id,
        facility_name,
        facility_type,
        city,
        state,
        zip_code,
        district,
        region,
        latitude,
        longitude,

        -- Capacity metrics
        current_utilization_pct,
        CASE
            WHEN current_utilization_pct IS NULL THEN 'UNKNOWN'
            WHEN current_utilization_pct >= {{ var('overcapacity_threshold_pct') }} THEN 'OVER_CAPACITY'
            WHEN current_utilization_pct >= 70 THEN 'OPTIMAL'
            WHEN current_utilization_pct >= {{ var('underutilized_threshold_pct') }} THEN 'MODERATE'
            ELSE 'UNDERUTILIZED'
        END AS utilization_status,
        max_throughput_daily,
        avg_daily_throughput AS actual_throughput_daily,
        avg_daily_spare_capacity AS spare_capacity_daily,

        -- Volume breakdown
        avg_letters,
        avg_parcels,
        avg_total_pieces,

        -- Equipment
        sorting_machines,
        avg_machine_utilization_pct,
        delivery_vehicles,

        -- Staffing
        avg_employees,
        avg_pieces_per_employee,
        avg_overtime_pct,

        -- Cost
        avg_cost_per_piece,
        avg_daily_cost,
        avg_daily_revenue,

        -- Facility characteristics
        square_footage,
        facility_age_years,
        delivery_routes,

        -- Utilization trend
        utilization_trend_30d,
        CASE
            WHEN utilization_trend_30d IS NULL THEN 'UNKNOWN'
            WHEN utilization_trend_30d > 5 THEN 'INCREASING'
            WHEN utilization_trend_30d < -5 THEN 'DECREASING'
            ELSE 'STABLE'
        END AS utilization_trend,

        -- Consolidation analysis
        nearest_facility_miles,
        nearest_facility_id,
        nearest_facility_spare_capacity_pct,
        consolidation_score,

        -- Consolidation recommendation
        CASE
            WHEN consolidation_score >= 75 THEN 'STRONG_CONSOLIDATION_CANDIDATE'
            WHEN consolidation_score >= 60 THEN 'REVIEW_FOR_CONSOLIDATION'
            WHEN consolidation_score >= 40 THEN 'MONITOR'
            ELSE 'RETAIN'
        END AS consolidation_recommendation,

        -- Rankings
        ROW_NUMBER() OVER (
            PARTITION BY region
            ORDER BY consolidation_score DESC
        ) AS region_consolidation_rank,

        ROW_NUMBER() OVER (
            ORDER BY consolidation_score DESC
        ) AS national_consolidation_rank,

        -- Metadata
        latest_report_date,
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM consolidation_analysis
)

SELECT * FROM final
ORDER BY consolidation_score DESC
