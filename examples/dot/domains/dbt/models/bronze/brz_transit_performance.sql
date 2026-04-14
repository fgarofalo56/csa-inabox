{{ config(
    materialized='incremental',
    unique_key=['agency_id', 'mode_code', 'route_id', 'service_date'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'ntd', 'transit_performance']
) }}

/*
    Bronze Layer: Transit Performance Data
    Source: FTA National Transit Database (NTD)
    Description: Raw transit agency performance metrics from NTD reporting.
                 Includes ridership, service metrics, and operational data
                 for all transit agencies receiving FTA funding.

    Grain: One row per agency + mode + route + service date
    Update frequency: Monthly (preliminary), Annual (final)
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'FTA_NTD' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Agency identifiers
        CAST(ntd_id AS STRING) AS agency_id,
        CAST(agency_name AS STRING) AS agency_name,
        CAST(city AS STRING) AS city,
        CAST(state AS STRING) AS state_code,
        CAST(uza_name AS STRING) AS urbanized_area_name,
        CAST(uza_population AS INT) AS urbanized_area_population,
        CAST(agency_type AS STRING) AS agency_type,
        CAST(reporter_type AS STRING) AS reporter_type,

        -- Mode and service identifiers
        CAST(mode AS STRING) AS mode_code,
        CAST(mode_name AS STRING) AS mode_name,
        CAST(tos AS STRING) AS type_of_service,
        CAST(route_id AS STRING) AS route_id,
        CAST(route_name AS STRING) AS route_name,

        -- Temporal fields
        TRY_CAST(service_date AS DATE) AS service_date,
        CAST(report_year AS INT) AS report_year,
        CAST(report_month AS INT) AS report_month,

        -- Service metrics
        CAST(scheduled_trips AS INT) AS scheduled_trips,
        CAST(actual_trips AS INT) AS actual_trips,
        CAST(on_time_trips AS INT) AS on_time_trips,
        CAST(missed_trips AS INT) AS missed_trips,

        -- Ridership
        CAST(unlinked_passenger_trips AS BIGINT) AS ridership,
        CAST(passenger_miles AS BIGINT) AS passenger_miles,
        CAST(avg_trip_length AS DECIMAL(8, 2)) AS avg_trip_length_miles,

        -- Vehicle utilization
        CAST(vehicle_revenue_hours AS DECIMAL(12, 2)) AS vehicle_revenue_hours,
        CAST(vehicle_revenue_miles AS DECIMAL(12, 2)) AS vehicle_revenue_miles,
        CAST(vehicles_operated AS INT) AS vehicles_operated_max_service,
        CAST(vehicles_available AS INT) AS vehicles_available_max_service,
        CAST(total_vehicles AS INT) AS total_fleet_vehicles,
        CAST(avg_vehicle_age AS DECIMAL(5, 1)) AS avg_fleet_age_years,

        -- Safety metrics
        CAST(incidents AS INT) AS safety_incidents,
        CAST(fatalities AS INT) AS fatalities,
        CAST(injuries AS INT) AS injuries,

        -- Financial (when available)
        CAST(operating_expense AS DECIMAL(14, 2)) AS operating_expense,
        CAST(fare_revenue AS DECIMAL(14, 2)) AS fare_revenue,
        CAST(federal_funding AS DECIMAL(14, 2)) AS federal_funding,

        -- Data quality flags
        CASE
            WHEN ntd_id IS NULL THEN FALSE
            WHEN mode IS NULL THEN FALSE
            WHEN report_year IS NULL OR report_year < 1990 OR report_year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN scheduled_trips IS NOT NULL AND scheduled_trips < 0 THEN FALSE
            WHEN actual_trips IS NOT NULL AND actual_trips < 0 THEN FALSE
            WHEN on_time_trips IS NOT NULL AND on_time_trips < 0 THEN FALSE
            WHEN unlinked_passenger_trips IS NOT NULL AND unlinked_passenger_trips < 0 THEN FALSE
            WHEN on_time_trips IS NOT NULL AND actual_trips IS NOT NULL
                 AND on_time_trips > actual_trips THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN ntd_id IS NULL THEN 'Missing agency ID'
            WHEN mode IS NULL THEN 'Missing mode'
            WHEN report_year IS NULL THEN 'Missing report year'
            WHEN scheduled_trips IS NOT NULL AND scheduled_trips < 0 THEN 'Negative scheduled trips'
            WHEN on_time_trips IS NOT NULL AND actual_trips IS NOT NULL
                 AND on_time_trips > actual_trips THEN 'On-time exceeds actual trips'
            ELSE NULL
        END AS validation_errors,

        -- Raw preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        MD5(CONCAT_WS('|',
            COALESCE(CAST(ntd_id AS STRING), ''),
            COALESCE(CAST(mode AS STRING), ''),
            COALESCE(CAST(route_id AS STRING), ''),
            COALESCE(CAST(service_date AS STRING), CONCAT(report_year, '-', LPAD(report_month, 2, '0')))
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('dot', 'ntd_transit_performance') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND agency_id IS NOT NULL
    AND mode_code IS NOT NULL
    AND report_year IS NOT NULL
