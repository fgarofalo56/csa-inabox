{{ config(
    materialized='table',
    tags=['gold', 'infrastructure', 'priority', 'analytics']
) }}

/*
    Gold Layer: Infrastructure Maintenance Prioritization
    Description: Bridges and highway segments ranked by a composite priority score
                 that factors condition (40%), traffic volume (30%), structure age
                 (20%), and deterioration trend (10%). Includes predicted years
                 until reaching 'poor' condition and estimated repair costs.

    Business Use Cases:
      - Optimize limited maintenance/repair budgets across bridge inventory
      - Identify bridges at risk of falling below acceptable condition thresholds
      - Support National Bridge Inspection Standards (NBIS) compliance
      - Generate state DOT capital improvement program recommendations
*/

WITH current_conditions AS (
    SELECT
        infrastructure_sk,
        bridge_id,
        route_id,
        route_prefix,
        facility_carried,
        features_intersected,
        state_code,
        state_name,
        county_code,
        county_name,
        latitude,
        longitude,
        inspection_year,
        year_built,
        year_reconstructed,
        structure_age_years,
        years_since_reconstruction,
        deck_condition_rating,
        superstructure_condition_rating,
        substructure_condition_rating,
        channel_condition_rating,
        min_condition_rating,
        condition_category,
        structure_type,
        structure_length_m,
        deck_width_m,
        deck_area_sqm,
        max_span_length_m,
        average_daily_traffic,
        truck_percentage,
        traffic_category,
        pavement_iri,
        pavement_condition_category,
        sufficiency_rating,
        maintenance_urgency_score,
        maintenance_urgency
    FROM {{ ref('slv_highway_conditions') }}
    WHERE bridge_id IS NOT NULL
),

-- Get the latest inspection for each bridge
latest_inspection AS (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY bridge_id, state_code
            ORDER BY inspection_year DESC
        ) AS rn
    FROM current_conditions
),

-- Calculate historical deterioration rate using prior inspections
deterioration_analysis AS (
    SELECT
        bridge_id,
        state_code,

        -- Average annual condition decline over observed history
        CASE
            WHEN COUNT(*) >= 2 AND MAX(inspection_year) > MIN(inspection_year)
            THEN ROUND(
                (MAX(min_condition_rating) - MIN(min_condition_rating))::DECIMAL
                / NULLIF(MAX(inspection_year) - MIN(inspection_year), 0)
            , 3)
            ELSE NULL
        END AS annual_condition_change,

        -- Number of inspections used for trend
        COUNT(*) AS inspection_count,
        MIN(inspection_year) AS earliest_inspection_year,
        MAX(inspection_year) AS latest_inspection_year

    FROM current_conditions
    GROUP BY bridge_id, state_code
),

-- Join latest conditions with deterioration trends
bridge_analysis AS (
    SELECT
        l.*,
        d.annual_condition_change,
        d.inspection_count,

        -- Predicted years until condition reaches 'poor' threshold
        CASE
            WHEN d.annual_condition_change IS NOT NULL AND d.annual_condition_change < 0
                 AND l.min_condition_rating > {{ var('condition_poor_threshold') }}
            THEN ROUND(
                (l.min_condition_rating - {{ var('condition_poor_threshold') }})
                / ABS(d.annual_condition_change)
            , 0)
            WHEN l.min_condition_rating <= {{ var('condition_poor_threshold') }}
            THEN 0  -- Already poor or critical
            ELSE NULL  -- No deterioration trend or improving
        END AS predicted_years_to_poor,

        -- Predicted years until critical
        CASE
            WHEN d.annual_condition_change IS NOT NULL AND d.annual_condition_change < 0
                 AND l.min_condition_rating > {{ var('condition_critical_threshold') }}
            THEN ROUND(
                (l.min_condition_rating - {{ var('condition_critical_threshold') }})
                / ABS(d.annual_condition_change)
            , 0)
            WHEN l.min_condition_rating <= {{ var('condition_critical_threshold') }}
            THEN 0
            ELSE NULL
        END AS predicted_years_to_critical

    FROM latest_inspection l
    LEFT JOIN deterioration_analysis d
        ON l.bridge_id = d.bridge_id
        AND l.state_code = d.state_code
    WHERE l.rn = 1  -- Latest inspection only
),

-- Calculate composite priority score and estimated repair costs
priority_scoring AS (
    SELECT
        b.*,

        -- Composite priority score (0-100)
        -- Condition (40%) + Traffic (30%) + Age (20%) + Deterioration Trend (10%)
        ROUND(
            -- Condition component
            (CASE
                WHEN min_condition_rating <= 2 THEN 100
                WHEN min_condition_rating <= 3 THEN 90
                WHEN min_condition_rating <= 4 THEN 75
                WHEN min_condition_rating <= 5 THEN 55
                WHEN min_condition_rating <= 6 THEN 35
                WHEN min_condition_rating <= 7 THEN 15
                ELSE 5
            END * {{ var('condition_weight') }})

            -- Traffic impact component
            + (CASE
                WHEN average_daily_traffic >= 100000 THEN 100
                WHEN average_daily_traffic >= 50000 THEN 90
                WHEN average_daily_traffic >= 20000 THEN 75
                WHEN average_daily_traffic >= 10000 THEN 55
                WHEN average_daily_traffic >= 5000 THEN 35
                WHEN average_daily_traffic >= 1000 THEN 15
                ELSE 5
            END * {{ var('traffic_weight') }})

            -- Age component
            + (CASE
                WHEN structure_age_years >= 100 THEN 100
                WHEN structure_age_years >= 75 THEN 85
                WHEN structure_age_years >= 50 THEN 65
                WHEN structure_age_years >= 30 THEN 40
                WHEN structure_age_years >= 15 THEN 20
                ELSE 5
            END * {{ var('age_weight') }})

            -- Deterioration trend component
            + (CASE
                WHEN annual_condition_change IS NOT NULL AND annual_condition_change <= -0.3 THEN 100
                WHEN annual_condition_change IS NOT NULL AND annual_condition_change <= -0.2 THEN 80
                WHEN annual_condition_change IS NOT NULL AND annual_condition_change <= -0.1 THEN 60
                WHEN annual_condition_change IS NOT NULL AND annual_condition_change < 0 THEN 40
                WHEN annual_condition_change IS NULL THEN 30  -- Unknown = moderate concern
                ELSE 10  -- Stable or improving
            END * {{ var('trend_weight') }})
        , 2) AS composite_priority_score,

        -- Estimated repair cost (simplified model based on deck area and condition gap)
        -- Cost per sqm varies by condition gap: bigger gap = more expensive
        CASE
            WHEN deck_area_sqm IS NOT NULL
            THEN ROUND(
                deck_area_sqm * (
                    CASE
                        WHEN min_condition_rating <= 2 THEN 5000   -- Full replacement
                        WHEN min_condition_rating <= 4 THEN 3000   -- Major rehabilitation
                        WHEN min_condition_rating <= 5 THEN 1500   -- Significant repairs
                        WHEN min_condition_rating <= 6 THEN 750    -- Moderate maintenance
                        WHEN min_condition_rating <= 7 THEN 300    -- Preventive maintenance
                        ELSE 100                                    -- Routine upkeep
                    END
                ) / 1000000.0  -- Convert to millions
            , 2)
            ELSE NULL
        END AS estimated_repair_cost_millions,

        -- Funding tier recommendation
        CASE
            WHEN min_condition_rating <= {{ var('condition_critical_threshold') }} THEN 'EMERGENCY_FUNDING'
            WHEN min_condition_rating <= {{ var('condition_poor_threshold') }}
                 AND average_daily_traffic >= 10000 THEN 'HIGH_PRIORITY_CAPITAL'
            WHEN predicted_years_to_poor IS NOT NULL AND predicted_years_to_poor <= 5 THEN 'PLANNED_CAPITAL'
            WHEN min_condition_rating <= {{ var('condition_fair_threshold') }} THEN 'PREVENTIVE_MAINTENANCE'
            ELSE 'ROUTINE_MAINTENANCE'
        END AS funding_tier

    FROM bridge_analysis b
),

-- Final output with state and national rankings
final AS (
    SELECT
        -- Identifiers
        bridge_id,
        route_id,
        route_prefix,
        facility_carried,
        features_intersected,
        state_code,
        state_name,
        county_code,
        county_name,
        latitude,
        longitude,

        -- Temporal
        inspection_year,
        year_built,
        structure_age_years,

        -- Condition ratings
        deck_condition_rating,
        superstructure_condition_rating,
        substructure_condition_rating,
        min_condition_rating,
        condition_category,

        -- Structure characteristics
        structure_type,
        structure_length_m,
        deck_width_m,
        deck_area_sqm,

        -- Traffic
        average_daily_traffic,
        truck_percentage,
        traffic_category,

        -- Sufficiency
        sufficiency_rating,

        -- Priority scoring
        composite_priority_score,
        maintenance_urgency,
        maintenance_urgency_score,

        -- Deterioration analysis
        annual_condition_change,
        predicted_years_to_poor,
        predicted_years_to_critical,
        inspection_count,

        -- Cost estimation
        estimated_repair_cost_millions,
        funding_tier,

        -- Rankings
        ROW_NUMBER() OVER (
            PARTITION BY state_code
            ORDER BY composite_priority_score DESC
        ) AS state_priority_rank,

        ROW_NUMBER() OVER (
            ORDER BY composite_priority_score DESC
        ) AS national_priority_rank,

        -- Percentile within state
        ROUND(
            PERCENT_RANK() OVER (
                PARTITION BY state_code
                ORDER BY composite_priority_score
            ) * 100
        , 1) AS state_priority_percentile,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM priority_scoring
)

SELECT * FROM final
ORDER BY composite_priority_score DESC
