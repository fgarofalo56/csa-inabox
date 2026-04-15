{{ config(
    materialized='incremental',
    unique_key='facility_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'facility_operations', 'cleaned'],
    on_schema_change='fail'
) }}

/*
    Silver Layer: Facility Operations (Cleansed & Conformed)
    Description: Cleansed facility operational data with utilization rate
                 calculation, equipment efficiency metrics, and facility
                 classification. Supports facility consolidation analysis
                 and capacity planning.

    Transformations:
      - Utilization rate: actual_throughput / max_throughput
      - Equipment efficiency: active / total for machines and vehicles
      - Cost per piece calculation
      - Facility age and renovation status
      - Overcapacity and underutilization flagging
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_facility_operations') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|', facility_id, CAST(report_date AS STRING))) AS facility_sk,

        -- Identifiers
        facility_id,
        UPPER(TRIM(facility_name)) AS facility_name,

        -- Facility type standardization
        CASE UPPER(TRIM(facility_type))
            WHEN 'P&DC' THEN 'PROCESSING_DISTRIBUTION_CENTER'
            WHEN 'PDC' THEN 'PROCESSING_DISTRIBUTION_CENTER'
            WHEN 'PROCESSING AND DISTRIBUTION CENTER' THEN 'PROCESSING_DISTRIBUTION_CENTER'
            WHEN 'NDC' THEN 'NETWORK_DISTRIBUTION_CENTER'
            WHEN 'NETWORK DISTRIBUTION CENTER' THEN 'NETWORK_DISTRIBUTION_CENTER'
            WHEN 'PO' THEN 'POST_OFFICE'
            WHEN 'POST OFFICE' THEN 'POST_OFFICE'
            WHEN 'STATION' THEN 'STATION'
            WHEN 'BRANCH' THEN 'BRANCH'
            WHEN 'ANNEX' THEN 'ANNEX'
            WHEN 'DDC' THEN 'DELIVERY_DISTRIBUTION_CENTER'
            ELSE UPPER(TRIM(facility_type))
        END AS facility_type,

        facility_subtype,

        -- Geographic
        UPPER(TRIM(city)) AS city,
        UPPER(TRIM(state)) AS state,
        LPAD(LEFT(TRIM(zip_code), 5), 5, '0') AS zip_code,
        UPPER(TRIM(district)) AS district,
        UPPER(TRIM(area)) AS area,
        UPPER(TRIM(region)) AS region,
        latitude,
        longitude,

        -- Temporal
        report_date,
        report_year,
        report_month,
        DAYOFWEEK(report_date) AS report_dow,
        CASE WHEN DAYOFWEEK(report_date) IN (1, 7) THEN FALSE ELSE TRUE END AS is_business_day,

        -- Throughput
        max_throughput_daily,
        actual_throughput_daily,
        letters_processed,
        flats_processed,
        parcels_processed,
        total_pieces_processed,

        -- Utilization rate
        CASE
            WHEN max_throughput_daily IS NOT NULL AND max_throughput_daily > 0
                 AND actual_throughput_daily IS NOT NULL
            THEN ROUND(CAST(actual_throughput_daily AS DECIMAL(14, 4)) / max_throughput_daily * 100, 2)
            ELSE NULL
        END AS utilization_pct,

        -- Utilization category
        CASE
            WHEN max_throughput_daily IS NULL OR max_throughput_daily = 0 THEN 'UNKNOWN'
            WHEN CAST(actual_throughput_daily AS DECIMAL) / max_throughput_daily * 100
                 >= {{ var('overcapacity_threshold_pct') }} THEN 'OVER_CAPACITY'
            WHEN CAST(actual_throughput_daily AS DECIMAL) / max_throughput_daily * 100
                 >= 70 THEN 'OPTIMAL'
            WHEN CAST(actual_throughput_daily AS DECIMAL) / max_throughput_daily * 100
                 >= {{ var('underutilized_threshold_pct') }} THEN 'MODERATE'
            ELSE 'UNDERUTILIZED'
        END AS utilization_category,

        -- Equipment metrics
        sorting_machines,
        sorting_machines_active,
        CASE
            WHEN sorting_machines IS NOT NULL AND sorting_machines > 0
                 AND sorting_machines_active IS NOT NULL
            THEN ROUND(CAST(sorting_machines_active AS DECIMAL(8, 4)) / sorting_machines * 100, 1)
            ELSE NULL
        END AS sorting_machine_utilization_pct,

        delivery_vehicles,
        delivery_vehicles_active,
        CASE
            WHEN delivery_vehicles IS NOT NULL AND delivery_vehicles > 0
                 AND delivery_vehicles_active IS NOT NULL
            THEN ROUND(CAST(delivery_vehicles_active AS DECIMAL(8, 4)) / delivery_vehicles * 100, 1)
            ELSE NULL
        END AS vehicle_utilization_pct,

        -- Staffing
        total_employees,
        carriers,
        clerks,
        supervisors,

        -- Pieces per employee (labor efficiency)
        CASE
            WHEN total_employees IS NOT NULL AND total_employees > 0
                 AND total_pieces_processed IS NOT NULL
            THEN ROUND(CAST(total_pieces_processed AS DECIMAL(14, 4)) / total_employees, 0)
            ELSE NULL
        END AS pieces_per_employee,

        -- Operating metrics
        operating_hours,
        overtime_hours,

        -- Overtime ratio
        CASE
            WHEN operating_hours IS NOT NULL AND operating_hours > 0
                 AND overtime_hours IS NOT NULL
            THEN ROUND(overtime_hours / operating_hours * 100, 1)
            ELSE NULL
        END AS overtime_pct,

        operating_cost_daily,
        revenue_daily,

        -- Cost per piece
        CASE
            WHEN total_pieces_processed IS NOT NULL AND total_pieces_processed > 0
                 AND operating_cost_daily IS NOT NULL
            THEN ROUND(operating_cost_daily / total_pieces_processed, 4)
            ELSE NULL
        END AS cost_per_piece,

        -- Revenue per piece
        CASE
            WHEN total_pieces_processed IS NOT NULL AND total_pieces_processed > 0
                 AND revenue_daily IS NOT NULL
            THEN ROUND(revenue_daily / total_pieces_processed, 4)
            ELSE NULL
        END AS revenue_per_piece,

        -- Facility characteristics
        square_footage,
        year_built,
        last_renovation_year,
        po_boxes,
        delivery_routes,

        -- Facility age
        CASE
            WHEN year_built IS NOT NULL AND year_built > 1900
            THEN YEAR(report_date) - year_built
            ELSE NULL
        END AS facility_age_years,

        -- Source tracking
        source_system,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
