{{ config(
    materialized='incremental',
    unique_key=['route_id', 'bridge_id', 'state_code', 'inspection_year'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'fhwa', 'highway_conditions'],
    on_schema_change='fail'
) }}

/*
    Bronze Layer: Highway Infrastructure Conditions
    Source: FHWA National Bridge Inventory (NBI) and Highway Performance
            Monitoring System (HPMS)
    Description: Raw bridge inspection records and pavement condition data.
                 Bridge records follow the NBI coding guide with 0-9 condition
                 ratings for deck, superstructure, and substructure.

    Grain: One row per bridge/route segment per inspection year
    Update frequency: Annual (NBI), quarterly (pavement segments)
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'FHWA_NBI' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Infrastructure identifiers
        CAST(structure_number AS STRING) AS bridge_id,
        CAST(route_number AS STRING) AS route_id,
        CAST(route_prefix AS STRING) AS route_prefix,
        CAST(facility_carried AS STRING) AS facility_carried,
        CAST(features_intersected AS STRING) AS features_intersected,

        -- Geographic identifiers
        LPAD(CAST(state_code AS STRING), 2, '0') AS state_code,
        CAST(state_name AS STRING) AS state_name,
        LPAD(CAST(county_code AS STRING), 3, '0') AS county_code,
        CAST(county_name AS STRING) AS county_name,
        CAST(place_code AS STRING) AS place_code,
        CAST(latitude AS DECIMAL(10, 6)) AS latitude,
        CAST(longitude AS DECIMAL(10, 6)) AS longitude,
        CAST(detour_length AS DECIMAL(8, 1)) AS detour_length_km,

        -- Temporal fields
        CAST(year AS INT) AS inspection_year,
        CAST(year_built AS INT) AS year_built,
        CAST(year_reconstructed AS INT) AS year_reconstructed,
        TRY_CAST(inspection_date AS DATE) AS last_inspection_date,

        -- Bridge condition ratings (NBI 0-9 scale)
        CAST(deck_cond AS INT) AS deck_condition_rating,
        CAST(superstructure_cond AS INT) AS superstructure_condition_rating,
        CAST(substructure_cond AS INT) AS substructure_condition_rating,
        CAST(channel_cond AS INT) AS channel_condition_rating,
        CAST(culvert_cond AS INT) AS culvert_condition_rating,

        -- Structural characteristics
        CAST(structure_type AS STRING) AS structure_type,
        CAST(structure_kind AS INT) AS structure_kind_code,
        CAST(structure_len AS DECIMAL(10, 1)) AS structure_length_m,
        CAST(deck_width AS DECIMAL(8, 1)) AS deck_width_m,
        CAST(max_span AS DECIMAL(10, 1)) AS max_span_length_m,
        CAST(num_spans_main AS INT) AS main_spans_count,
        CAST(num_spans_approach AS INT) AS approach_spans_count,

        -- Traffic data
        CAST(adt AS INT) AS average_daily_traffic,
        CAST(adt_year AS INT) AS adt_year,
        CAST(truck_pct AS DECIMAL(5, 2)) AS truck_percentage,
        CAST(design_load AS INT) AS design_load_code,

        -- Pavement data (from HPMS, when available)
        CAST(iri AS DECIMAL(8, 2)) AS pavement_iri,
        CAST(psr AS DECIMAL(5, 2)) AS pavement_service_rating,
        CAST(rutting AS DECIMAL(6, 2)) AS rutting_depth_mm,
        CAST(cracking_pct AS DECIMAL(5, 2)) AS cracking_percentage,
        CAST(faulting AS DECIMAL(6, 2)) AS faulting_mm,
        CAST(lanes AS INT) AS lane_count,

        -- Financial and rating
        CAST(sufficiency_rating AS DECIMAL(5, 2)) AS sufficiency_rating,
        CAST(status AS STRING) AS operating_status,
        CAST(owner AS INT) AS owner_code,
        CAST(maintenance_resp AS INT) AS maintenance_responsibility_code,

        -- Data quality flags
        CASE
            WHEN structure_number IS NULL AND route_number IS NULL THEN FALSE
            WHEN state_code IS NULL THEN FALSE
            WHEN year IS NULL THEN FALSE
            WHEN deck_cond IS NOT NULL AND (deck_cond < 0 OR deck_cond > 9) THEN FALSE
            WHEN superstructure_cond IS NOT NULL AND (superstructure_cond < 0 OR superstructure_cond > 9) THEN FALSE
            WHEN substructure_cond IS NOT NULL AND (substructure_cond < 0 OR substructure_cond > 9) THEN FALSE
            WHEN adt IS NOT NULL AND adt < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN structure_number IS NULL AND route_number IS NULL THEN 'Missing identifier'
            WHEN state_code IS NULL THEN 'Missing state code'
            WHEN year IS NULL THEN 'Missing inspection year'
            WHEN deck_cond IS NOT NULL AND (deck_cond < 0 OR deck_cond > 9) THEN 'Invalid deck condition'
            WHEN adt IS NOT NULL AND adt < 0 THEN 'Negative ADT'
            ELSE NULL
        END AS validation_errors,

        -- Raw preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        MD5(CONCAT_WS('|',
            COALESCE(CAST(structure_number AS STRING), ''),
            COALESCE(CAST(route_number AS STRING), ''),
            COALESCE(CAST(state_code AS STRING), ''),
            COALESCE(CAST(year AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('dot', 'highway_conditions') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND state_code IS NOT NULL
    AND inspection_year IS NOT NULL
    AND (bridge_id IS NOT NULL OR route_id IS NOT NULL)
