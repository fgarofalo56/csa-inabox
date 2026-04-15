{{ config(
    materialized='table',
    tags=['gold', 'route', 'optimization', 'analytics']
) }}

/*
    Gold Layer: Route Optimization
    Description: Delivery route performance analysis with efficiency scoring,
                 density metrics, and optimization opportunity identification.
                 Analyzes carrier routes by delivery density, time patterns,
                 and service quality to recommend route restructuring.

    Business Use Cases:
      - Identify inefficient routes for restructuring
      - Optimize delivery sequencing based on density patterns
      - Reduce last-mile costs through route consolidation
      - Support carrier workload balancing decisions
*/

WITH route_deliveries AS (
    SELECT
        carrier_route,
        destination_zip,
        district,
        region,
        destination_state,
        product_class,
        acceptance_date,
        acceptance_year,
        acceptance_month,
        is_on_time,
        calculated_delivery_days,
        service_standard_days,
        days_from_expected,
        delivery_attempt_count,
        carrier_type,
        delivery_method,
        weight_oz,
        is_intra_scf,
        is_intra_state
    FROM {{ ref('slv_delivery_performance') }}
    WHERE carrier_route IS NOT NULL
      AND acceptance_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years') }}
      AND delivery_status = 'DELIVERED'
),

-- Monthly route-level aggregation
route_monthly AS (
    SELECT
        carrier_route,
        destination_zip,
        district,
        region,
        destination_state AS state,
        acceptance_year,
        acceptance_month,

        -- Delivery counts
        COUNT(*) AS total_deliveries,
        COUNT(DISTINCT acceptance_date) AS active_days,

        -- Stops per day
        ROUND(COUNT(*)::DECIMAL / NULLIF(COUNT(DISTINCT acceptance_date), 0), 1) AS avg_deliveries_per_day,

        -- Product mix
        SUM(CASE WHEN product_class = 'FIRST_CLASS' THEN 1 ELSE 0 END) AS first_class_count,
        SUM(CASE WHEN product_class = 'PRIORITY' THEN 1 ELSE 0 END) AS priority_count,
        SUM(CASE WHEN product_class IN ('PARCEL_SELECT', 'PRIORITY_EXPRESS') THEN 1 ELSE 0 END) AS parcel_count,
        SUM(CASE WHEN product_class = 'MARKETING_MAIL' THEN 1 ELSE 0 END) AS marketing_count,

        -- Parcel percentage (indicator of package-heavy routes)
        ROUND(
            SUM(CASE WHEN product_class IN ('PARCEL_SELECT', 'PRIORITY', 'PRIORITY_EXPRESS') THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(*), 0)
        , 1) AS parcel_pct,

        -- Performance metrics
        ROUND(
            SUM(CASE WHEN is_on_time THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
        , 1) AS on_time_rate_pct,

        ROUND(AVG(calculated_delivery_days), 2) AS avg_delivery_days,

        -- Re-delivery attempts (indicator of first-attempt failure)
        ROUND(AVG(COALESCE(delivery_attempt_count, 1)), 2) AS avg_delivery_attempts,
        SUM(CASE WHEN delivery_attempt_count > 1 THEN 1 ELSE 0 END) AS re_delivery_count,

        -- Average weight per piece
        ROUND(AVG(weight_oz), 2) AS avg_weight_oz,

        -- Intra-SCF percentage (local delivery indicator)
        ROUND(
            SUM(CASE WHEN is_intra_scf THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0)
        , 1) AS intra_scf_pct,

        -- Carrier type
        MODE(carrier_type) AS predominant_carrier_type

    FROM route_deliveries
    GROUP BY carrier_route, destination_zip, district, region,
             destination_state, acceptance_year, acceptance_month
),

-- Calculate route efficiency score
route_scoring AS (
    SELECT
        rm.*,

        -- Route Efficiency Score (0-100)
        -- Factors: volume density (30%), on-time rate (30%), attempt efficiency (20%), delivery speed (20%)
        ROUND(
            -- Volume density: more deliveries per day = more efficient
            (CASE
                WHEN avg_deliveries_per_day >= 100 THEN 100
                WHEN avg_deliveries_per_day >= 75 THEN 85
                WHEN avg_deliveries_per_day >= 50 THEN 70
                WHEN avg_deliveries_per_day >= 25 THEN 50
                WHEN avg_deliveries_per_day >= 10 THEN 30
                ELSE 15
            END * 0.30)

            -- On-time performance
            + (LEAST(COALESCE(on_time_rate_pct, 50), 100) * 0.30)

            -- First-attempt delivery rate (fewer re-deliveries = more efficient)
            + (CASE
                WHEN avg_delivery_attempts <= 1.05 THEN 100
                WHEN avg_delivery_attempts <= 1.10 THEN 80
                WHEN avg_delivery_attempts <= 1.20 THEN 60
                WHEN avg_delivery_attempts <= 1.30 THEN 40
                ELSE 20
            END * 0.20)

            -- Delivery speed vs. standard
            + (CASE
                WHEN avg_delivery_days <= 1 THEN 100
                WHEN avg_delivery_days <= 2 THEN 85
                WHEN avg_delivery_days <= 3 THEN 70
                WHEN avg_delivery_days <= 5 THEN 50
                ELSE 25
            END * 0.20)
        , 1) AS optimization_score,

        -- Estimated time savings (minutes per day) from optimization
        CASE
            WHEN avg_delivery_attempts > 1.15
            THEN ROUND((avg_delivery_attempts - 1.0) * avg_deliveries_per_day * 5, 0)  -- 5 min per re-attempt
            WHEN avg_deliveries_per_day < {{ var('min_stops_per_route') }}
            THEN ROUND(({{ var('min_stops_per_route') }} - avg_deliveries_per_day) * 2, 0)  -- low density penalty
            ELSE 0
        END AS estimated_savings_minutes

    FROM route_monthly rm
),

-- Add trends and final output
final AS (
    SELECT
        -- Identifiers
        carrier_route AS route_id,
        destination_zip AS zip_code,
        district,
        region,
        state,
        predominant_carrier_type AS carrier_type,
        acceptance_year AS analysis_year,
        acceptance_month AS analysis_month,

        -- Volume metrics
        total_deliveries,
        active_days,
        avg_deliveries_per_day AS stops_per_day,

        -- Product mix
        first_class_count,
        priority_count,
        parcel_count,
        marketing_count,
        parcel_pct,

        -- Performance
        on_time_rate_pct,
        avg_delivery_days,
        avg_delivery_attempts,
        re_delivery_count,

        -- Efficiency
        optimization_score,
        estimated_savings_minutes,

        -- Optimization opportunity classification
        CASE
            WHEN optimization_score >= 80 THEN 'WELL_OPTIMIZED'
            WHEN optimization_score >= {{ var('efficiency_score_threshold') }} THEN 'ADEQUATE'
            WHEN optimization_score >= 50 THEN 'NEEDS_IMPROVEMENT'
            ELSE 'HIGH_OPTIMIZATION_POTENTIAL'
        END AS optimization_category,

        -- Specific recommendation
        CASE
            WHEN avg_delivery_attempts > 1.20 THEN 'REDUCE_REDELIVERY_RATE'
            WHEN avg_deliveries_per_day < 25 THEN 'CONSIDER_ROUTE_CONSOLIDATION'
            WHEN on_time_rate_pct < 80 THEN 'IMPROVE_ON_TIME_PERFORMANCE'
            WHEN parcel_pct > 50 AND avg_weight_oz > 32 THEN 'SEPARATE_PARCEL_ROUTE'
            ELSE 'MAINTAIN_CURRENT_OPERATIONS'
        END AS primary_recommendation,

        avg_weight_oz,
        intra_scf_pct,

        -- Year-over-year comparison
        LAG(total_deliveries, 12) OVER (
            PARTITION BY carrier_route
            ORDER BY acceptance_year, acceptance_month
        ) AS deliveries_same_month_prev_year,

        -- Ranking
        ROW_NUMBER() OVER (
            PARTITION BY district, acceptance_year, acceptance_month
            ORDER BY optimization_score ASC
        ) AS district_optimization_rank,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM route_scoring
)

SELECT * FROM final
ORDER BY optimization_score ASC, total_deliveries DESC
