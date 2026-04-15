{{ config(
    materialized='incremental',
    unique_key=['facility_id', 'report_date'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'usps', 'facility_operations']
) }}

/*
    Bronze Layer: Facility Operations
    Source: USPS processing and distribution facility metrics
    Description: Raw operational metrics for USPS processing plants, distribution
                 centers, and post offices. Includes throughput, capacity,
                 equipment utilization, and staffing data.

    Grain: One row per facility per report date
    Update frequency: Daily
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'USPS_FACILITY' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Facility identifiers
        CAST(facility_id AS STRING) AS facility_id,
        CAST(facility_name AS STRING) AS facility_name,
        CAST(facility_type AS STRING) AS facility_type,
        CAST(facility_subtype AS STRING) AS facility_subtype,

        -- Geographic fields
        CAST(address AS STRING) AS address,
        CAST(city AS STRING) AS city,
        CAST(state AS STRING) AS state,
        CAST(zip_code AS STRING) AS zip_code,
        CAST(district AS STRING) AS district,
        CAST(area AS STRING) AS area,
        CAST(region AS STRING) AS region,
        CAST(latitude AS DECIMAL(10, 6)) AS latitude,
        CAST(longitude AS DECIMAL(10, 6)) AS longitude,

        -- Temporal
        TRY_CAST(report_date AS DATE) AS report_date,
        CAST(report_year AS INT) AS report_year,
        CAST(report_month AS INT) AS report_month,

        -- Capacity metrics
        CAST(max_throughput_daily AS INT) AS max_throughput_daily,
        CAST(actual_throughput_daily AS INT) AS actual_throughput_daily,
        CAST(letters_processed AS BIGINT) AS letters_processed,
        CAST(flats_processed AS BIGINT) AS flats_processed,
        CAST(parcels_processed AS BIGINT) AS parcels_processed,
        CAST(total_pieces_processed AS BIGINT) AS total_pieces_processed,

        -- Equipment
        CAST(sorting_machines AS INT) AS sorting_machines,
        CAST(sorting_machines_active AS INT) AS sorting_machines_active,
        CAST(delivery_vehicles AS INT) AS delivery_vehicles,
        CAST(delivery_vehicles_active AS INT) AS delivery_vehicles_active,

        -- Staffing
        CAST(total_employees AS INT) AS total_employees,
        CAST(carriers AS INT) AS carriers,
        CAST(clerks AS INT) AS clerks,
        CAST(supervisors AS INT) AS supervisors,

        -- Operating metrics
        CAST(operating_hours AS DECIMAL(5, 1)) AS operating_hours,
        CAST(overtime_hours AS DECIMAL(8, 1)) AS overtime_hours,
        CAST(operating_cost_daily AS DECIMAL(12, 2)) AS operating_cost_daily,
        CAST(revenue_daily AS DECIMAL(12, 2)) AS revenue_daily,

        -- Facility characteristics
        CAST(square_footage AS INT) AS square_footage,
        CAST(year_built AS INT) AS year_built,
        CAST(last_renovation_year AS INT) AS last_renovation_year,
        CAST(po_boxes AS INT) AS po_boxes,
        CAST(delivery_routes AS INT) AS delivery_routes,

        -- Data quality flags
        CASE
            WHEN facility_id IS NULL THEN FALSE
            WHEN report_date IS NULL THEN FALSE
            WHEN facility_type IS NULL THEN FALSE
            WHEN actual_throughput_daily IS NOT NULL AND actual_throughput_daily < 0 THEN FALSE
            WHEN max_throughput_daily IS NOT NULL AND max_throughput_daily < 0 THEN FALSE
            WHEN actual_throughput_daily IS NOT NULL AND max_throughput_daily IS NOT NULL
                 AND actual_throughput_daily > max_throughput_daily * 1.5 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN facility_id IS NULL THEN 'Missing facility ID'
            WHEN report_date IS NULL THEN 'Missing report date'
            WHEN facility_type IS NULL THEN 'Missing facility type'
            WHEN actual_throughput_daily IS NOT NULL AND actual_throughput_daily < 0 THEN 'Negative throughput'
            WHEN actual_throughput_daily IS NOT NULL AND max_throughput_daily IS NOT NULL
                 AND actual_throughput_daily > max_throughput_daily * 1.5 THEN 'Throughput exceeds 150% capacity'
            ELSE NULL
        END AS validation_errors,

        -- Raw preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        MD5(CONCAT_WS('|',
            COALESCE(CAST(facility_id AS STRING), ''),
            COALESCE(CAST(report_date AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('usps', 'facility_operations') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND facility_id IS NOT NULL
    AND report_date IS NOT NULL
