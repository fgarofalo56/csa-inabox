{{ config(
    materialized='incremental',
    unique_key='transit_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'transit_performance', 'cleaned']
) }}

/*
    Silver Layer: Transit Performance (Cleansed & Conformed)
    Description: Cleansed NTD transit data with calculated on-time rate,
                 ridership per vehicle hour, and service reliability index.

    Transformations:
      - Standardized mode names and agency identifiers
      - On-time rate calculation: on_time_trips / actual_trips
      - Ridership efficiency: ridership / vehicle_revenue_hours
      - Service reliability index: composite of on-time, service delivery, fleet utilization
      - Null-safe calculations with appropriate defaults
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_transit_performance') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            agency_id,
            mode_code,
            COALESCE(route_id, 'ALL'),
            COALESCE(CAST(service_date AS STRING), CONCAT(report_year, '-', LPAD(report_month, 2, '0')))
        )) AS transit_sk,

        -- Agency identifiers
        agency_id,
        UPPER(TRIM(agency_name)) AS agency_name,
        UPPER(TRIM(city)) AS city,
        UPPER(TRIM(state_code)) AS state_code,
        UPPER(TRIM(urbanized_area_name)) AS urbanized_area_name,
        urbanized_area_population,
        agency_type,
        reporter_type,

        -- Mode standardization
        mode_code,
        CASE UPPER(TRIM(mode_code))
            WHEN 'MB' THEN 'BUS'
            WHEN 'HR' THEN 'HEAVY_RAIL'
            WHEN 'LR' THEN 'LIGHT_RAIL'
            WHEN 'CR' THEN 'COMMUTER_RAIL'
            WHEN 'DR' THEN 'DEMAND_RESPONSE'
            WHEN 'VP' THEN 'VANPOOL'
            WHEN 'CB' THEN 'COMMUTER_BUS'
            WHEN 'RB' THEN 'BUS_RAPID_TRANSIT'
            WHEN 'TB' THEN 'TROLLEYBUS'
            WHEN 'FB' THEN 'FERRYBOAT'
            WHEN 'MG' THEN 'MONORAIL'
            WHEN 'SR' THEN 'STREETCAR'
            WHEN 'CC' THEN 'CABLE_CAR'
            WHEN 'IP' THEN 'INCLINED_PLANE'
            WHEN 'AG' THEN 'AUTOMATED_GUIDEWAY'
            ELSE UPPER(TRIM(COALESCE(mode_name, mode_code)))
        END AS mode_name_standard,

        -- Mode category for high-level grouping
        CASE UPPER(TRIM(mode_code))
            WHEN 'MB' THEN 'BUS'
            WHEN 'CB' THEN 'BUS'
            WHEN 'RB' THEN 'BUS'
            WHEN 'TB' THEN 'BUS'
            WHEN 'HR' THEN 'RAIL'
            WHEN 'LR' THEN 'RAIL'
            WHEN 'CR' THEN 'RAIL'
            WHEN 'MG' THEN 'RAIL'
            WHEN 'SR' THEN 'RAIL'
            WHEN 'AG' THEN 'RAIL'
            WHEN 'DR' THEN 'DEMAND_RESPONSE'
            WHEN 'VP' THEN 'DEMAND_RESPONSE'
            WHEN 'FB' THEN 'FERRY'
            ELSE 'OTHER'
        END AS mode_category,

        type_of_service,
        route_id,
        route_name,

        -- Temporal
        service_date,
        report_year,
        report_month,

        -- Construct report_date if service_date is null
        COALESCE(
            service_date,
            TRY_CAST(CONCAT(report_year, '-', LPAD(report_month, 2, '0'), '-01') AS DATE)
        ) AS report_date,

        -- Service metrics (null-safe)
        COALESCE(scheduled_trips, 0) AS scheduled_trips,
        COALESCE(actual_trips, 0) AS actual_trips,
        COALESCE(on_time_trips, 0) AS on_time_trips,
        COALESCE(missed_trips, 0) AS missed_trips,

        -- On-time rate calculation
        CASE
            WHEN actual_trips IS NOT NULL AND actual_trips > 0
                 AND on_time_trips IS NOT NULL
            THEN ROUND(CAST(on_time_trips AS DECIMAL(12, 4)) / actual_trips * 100, 2)
            ELSE NULL
        END AS on_time_rate_pct,

        -- Service delivery rate (actual / scheduled)
        CASE
            WHEN scheduled_trips IS NOT NULL AND scheduled_trips > 0
                 AND actual_trips IS NOT NULL
            THEN ROUND(CAST(actual_trips AS DECIMAL(12, 4)) / scheduled_trips * 100, 2)
            ELSE NULL
        END AS service_delivery_rate_pct,

        -- Ridership
        COALESCE(ridership, 0) AS ridership,
        passenger_miles,
        avg_trip_length_miles,

        -- Vehicle utilization
        vehicle_revenue_hours,
        vehicle_revenue_miles,
        vehicles_operated_max_service,
        vehicles_available_max_service,
        total_fleet_vehicles,
        avg_fleet_age_years,

        -- Ridership per vehicle revenue hour (efficiency metric)
        CASE
            WHEN vehicle_revenue_hours IS NOT NULL AND vehicle_revenue_hours > 0
                 AND ridership IS NOT NULL
            THEN ROUND(CAST(ridership AS DECIMAL(14, 4)) / vehicle_revenue_hours, 2)
            ELSE NULL
        END AS ridership_per_vehicle_hour,

        -- Revenue miles per vehicle hour (speed/coverage proxy)
        CASE
            WHEN vehicle_revenue_hours IS NOT NULL AND vehicle_revenue_hours > 0
                 AND vehicle_revenue_miles IS NOT NULL
            THEN ROUND(vehicle_revenue_miles / vehicle_revenue_hours, 2)
            ELSE NULL
        END AS avg_speed_mph,

        -- Fleet utilization rate
        CASE
            WHEN vehicles_available_max_service IS NOT NULL AND vehicles_available_max_service > 0
                 AND vehicles_operated_max_service IS NOT NULL
            THEN ROUND(CAST(vehicles_operated_max_service AS DECIMAL(8, 4)) / vehicles_available_max_service * 100, 2)
            ELSE NULL
        END AS fleet_utilization_pct,

        -- Safety
        safety_incidents,
        fatalities,
        injuries,

        -- Financials
        operating_expense,
        fare_revenue,
        federal_funding,

        -- Cost per trip
        CASE
            WHEN ridership IS NOT NULL AND ridership > 0
                 AND operating_expense IS NOT NULL
            THEN ROUND(operating_expense / ridership, 2)
            ELSE NULL
        END AS cost_per_trip,

        -- Farebox recovery ratio
        CASE
            WHEN operating_expense IS NOT NULL AND operating_expense > 0
                 AND fare_revenue IS NOT NULL
            THEN ROUND(fare_revenue / operating_expense * 100, 2)
            ELSE NULL
        END AS farebox_recovery_pct,

        -- Source tracking
        source_system,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
),

-- Calculate service reliability index
enriched AS (
    SELECT
        s.*,

        -- Service Reliability Index (SRI): 0-100 composite score
        -- Factors: on-time performance (50%), service delivery (30%), fleet utilization (20%)
        ROUND(
            (COALESCE(on_time_rate_pct, 50) * 0.50)
            + (COALESCE(service_delivery_rate_pct, 50) * 0.30)
            + (COALESCE(fleet_utilization_pct, 50) * 0.20)
        , 2) AS service_reliability_index,

        -- Reliability classification
        CASE
            WHEN COALESCE(on_time_rate_pct, 0) >= {{ var('on_time_target_pct') }}
                 AND COALESCE(service_delivery_rate_pct, 0) >= 95 THEN 'EXCELLENT'
            WHEN COALESCE(on_time_rate_pct, 0) >= 75
                 AND COALESCE(service_delivery_rate_pct, 0) >= 90 THEN 'GOOD'
            WHEN COALESCE(on_time_rate_pct, 0) >= 60
                 AND COALESCE(service_delivery_rate_pct, 0) >= 80 THEN 'FAIR'
            ELSE 'POOR'
        END AS reliability_category

    FROM standardized s
)

SELECT * FROM enriched
