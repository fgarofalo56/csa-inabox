{{ config(
    materialized='incremental',
    unique_key='infrastructure_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'highway_conditions', 'cleaned']
) }}

/*
    Silver Layer: Highway & Bridge Conditions (Cleansed & Conformed)
    Description: Cleansed bridge and highway infrastructure data with derived
                 condition categorization (good/fair/poor/critical), structure
                 age calculation, and maintenance urgency scoring.

    Transformations:
      - NBI condition ratings categorized into good/fair/poor/critical
      - Structure age calculation from year_built
      - Minimum condition rating derived across deck/super/sub
      - Maintenance urgency score based on condition + traffic + age
      - Pavement IRI categorization
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_highway_conditions') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            COALESCE(bridge_id, ''),
            COALESCE(route_id, ''),
            state_code,
            CAST(inspection_year AS STRING)
        )) AS infrastructure_sk,

        -- Identifiers
        bridge_id,
        route_id,
        route_prefix,
        facility_carried,
        features_intersected,

        -- Geographic
        state_code,
        state_name,
        county_code,
        county_name,
        latitude,
        longitude,
        detour_length_km,

        -- Temporal
        inspection_year,
        year_built,
        year_reconstructed,
        last_inspection_date,

        -- Structure age calculation
        CASE
            WHEN year_built IS NOT NULL AND year_built > 1800 AND year_built <= inspection_year
            THEN inspection_year - year_built
            ELSE NULL
        END AS structure_age_years,

        -- Time since last reconstruction
        CASE
            WHEN year_reconstructed IS NOT NULL AND year_reconstructed > year_built
            THEN inspection_year - year_reconstructed
            ELSE NULL
        END AS years_since_reconstruction,

        -- Condition ratings (raw NBI 0-9)
        deck_condition_rating,
        superstructure_condition_rating,
        substructure_condition_rating,
        channel_condition_rating,
        culvert_condition_rating,

        -- Minimum condition rating across primary structural elements
        LEAST(
            COALESCE(deck_condition_rating, 9),
            COALESCE(superstructure_condition_rating, 9),
            COALESCE(substructure_condition_rating, 9)
        ) AS min_condition_rating,

        -- Condition category based on minimum rating
        CASE
            WHEN LEAST(
                COALESCE(deck_condition_rating, 9),
                COALESCE(superstructure_condition_rating, 9),
                COALESCE(substructure_condition_rating, 9)
            ) <= {{ var('condition_critical_threshold') }} THEN 'CRITICAL'
            WHEN LEAST(
                COALESCE(deck_condition_rating, 9),
                COALESCE(superstructure_condition_rating, 9),
                COALESCE(substructure_condition_rating, 9)
            ) <= {{ var('condition_poor_threshold') }} THEN 'POOR'
            WHEN LEAST(
                COALESCE(deck_condition_rating, 9),
                COALESCE(superstructure_condition_rating, 9),
                COALESCE(substructure_condition_rating, 9)
            ) <= {{ var('condition_fair_threshold') }} THEN 'FAIR'
            ELSE 'GOOD'
        END AS condition_category,

        -- Structural characteristics
        structure_type,
        structure_kind_code,
        structure_length_m,
        deck_width_m,
        max_span_length_m,
        main_spans_count,
        approach_spans_count,

        -- Deck area (sq meters) for cost estimation
        CASE
            WHEN structure_length_m IS NOT NULL AND deck_width_m IS NOT NULL
                 AND structure_length_m > 0 AND deck_width_m > 0
            THEN ROUND(structure_length_m * deck_width_m, 1)
            ELSE NULL
        END AS deck_area_sqm,

        -- Traffic data
        average_daily_traffic,
        adt_year,
        truck_percentage,

        -- Traffic category for prioritization
        CASE
            WHEN average_daily_traffic IS NULL THEN 'UNKNOWN'
            WHEN average_daily_traffic >= 50000 THEN 'VERY_HIGH'
            WHEN average_daily_traffic >= 20000 THEN 'HIGH'
            WHEN average_daily_traffic >= 5000 THEN 'MODERATE'
            WHEN average_daily_traffic >= 1000 THEN 'LOW'
            ELSE 'VERY_LOW'
        END AS traffic_category,

        -- Pavement data
        pavement_iri,
        pavement_service_rating,
        rutting_depth_mm,
        cracking_percentage,
        faulting_mm,
        lane_count,

        -- Pavement condition category (IRI-based)
        CASE
            WHEN pavement_iri IS NULL THEN NULL
            WHEN pavement_iri <= 95 THEN 'GOOD'
            WHEN pavement_iri <= 170 THEN 'FAIR'
            WHEN pavement_iri <= 220 THEN 'POOR'
            ELSE 'CRITICAL'
        END AS pavement_condition_category,

        -- Financial and status
        sufficiency_rating,
        operating_status,
        owner_code,
        maintenance_responsibility_code,

        -- Source tracking
        source_system,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
),

-- Calculate maintenance urgency score
scored AS (
    SELECT
        s.*,

        -- Maintenance urgency score (0-100 scale)
        -- Factors: condition (40%), traffic impact (30%), age (20%), pavement (10%)
        ROUND(
            -- Condition component: lower rating = higher urgency
            (CASE
                WHEN min_condition_rating <= 2 THEN 100
                WHEN min_condition_rating <= 4 THEN 80
                WHEN min_condition_rating <= 5 THEN 60
                WHEN min_condition_rating <= 6 THEN 40
                WHEN min_condition_rating <= 7 THEN 20
                ELSE 5
            END * {{ var('condition_weight') }})

            -- Traffic component: higher traffic = higher urgency
            + (CASE
                WHEN average_daily_traffic >= 50000 THEN 100
                WHEN average_daily_traffic >= 20000 THEN 80
                WHEN average_daily_traffic >= 10000 THEN 60
                WHEN average_daily_traffic >= 5000 THEN 40
                WHEN average_daily_traffic >= 1000 THEN 20
                ELSE 5
            END * {{ var('traffic_weight') }})

            -- Age component: older = higher urgency
            + (CASE
                WHEN structure_age_years IS NULL THEN 30
                WHEN structure_age_years >= 75 THEN 100
                WHEN structure_age_years >= 50 THEN 80
                WHEN structure_age_years >= 30 THEN 50
                WHEN structure_age_years >= 15 THEN 25
                ELSE 10
            END * {{ var('age_weight') }})

            -- Trend component: sufficiency rating proxy
            + (CASE
                WHEN sufficiency_rating IS NULL THEN 30
                WHEN sufficiency_rating < 20 THEN 100
                WHEN sufficiency_rating < 50 THEN 75
                WHEN sufficiency_rating < 80 THEN 40
                ELSE 10
            END * {{ var('trend_weight') }})
        , 2) AS maintenance_urgency_score,

        -- Urgency classification
        CASE
            WHEN min_condition_rating <= {{ var('condition_critical_threshold') }}
                 OR sufficiency_rating < 20 THEN 'CRITICAL'
            WHEN min_condition_rating <= {{ var('condition_poor_threshold') }}
                 OR sufficiency_rating < 50 THEN 'HIGH'
            WHEN min_condition_rating <= {{ var('condition_fair_threshold') }} THEN 'MODERATE'
            ELSE 'LOW'
        END AS maintenance_urgency

    FROM standardized s
)

SELECT * FROM scored
