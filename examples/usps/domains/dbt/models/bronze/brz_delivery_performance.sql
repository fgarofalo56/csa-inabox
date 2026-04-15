{{ config(
    materialized='incremental',
    unique_key=['tracking_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'usps', 'delivery_performance'],
    on_schema_change='fail'
) }}

/*
    Bronze Layer: Delivery Performance
    Source: USPS delivery tracking and service performance data
    Description: Raw delivery performance records capturing individual mail piece
                 or parcel tracking from acceptance to delivery. Each record
                 represents a single delivery event with origin, destination,
                 timing, and service class information.

    Grain: One row per tracking ID (delivery event)
    Update frequency: Daily
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'USPS_DELIVERY' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Delivery identifiers
        CAST(tracking_id AS STRING) AS tracking_id,
        CAST(carrier_route AS STRING) AS carrier_route,
        CAST(delivery_unit AS STRING) AS delivery_unit,

        -- Geographic fields
        CAST(origin_zip AS STRING) AS origin_zip,
        CAST(origin_city AS STRING) AS origin_city,
        CAST(origin_state AS STRING) AS origin_state,
        CAST(destination_zip AS STRING) AS destination_zip,
        CAST(destination_city AS STRING) AS destination_city,
        CAST(destination_state AS STRING) AS destination_state,
        CAST(district AS STRING) AS district,
        CAST(region AS STRING) AS region,

        -- Product classification
        CAST(product_class AS STRING) AS product_class,
        CAST(service_type AS STRING) AS service_type,
        CAST(mail_shape AS STRING) AS mail_shape,
        CAST(weight_oz AS DECIMAL(10, 2)) AS weight_oz,

        -- Temporal fields
        TRY_CAST(acceptance_datetime AS TIMESTAMP) AS acceptance_datetime,
        TRY_CAST(acceptance_date AS DATE) AS acceptance_date,
        TRY_CAST(expected_delivery_date AS DATE) AS expected_delivery_date,
        TRY_CAST(actual_delivery_date AS DATE) AS actual_delivery_date,
        TRY_CAST(actual_delivery_datetime AS TIMESTAMP) AS actual_delivery_datetime,

        -- Delivery metrics
        CAST(delivery_status AS STRING) AS delivery_status,
        CAST(delivery_time_days AS DECIMAL(8, 2)) AS delivery_time_days,
        CAST(service_standard_days AS INT) AS service_standard_days,
        CAST(delivery_attempt_count AS INT) AS delivery_attempt_count,

        -- Facility routing
        CAST(origin_facility_id AS STRING) AS origin_facility_id,
        CAST(destination_facility_id AS STRING) AS destination_facility_id,
        CAST(processing_facility_id AS STRING) AS processing_facility_id,

        -- Carrier information
        CAST(carrier_type AS STRING) AS carrier_type,
        CAST(delivery_method AS STRING) AS delivery_method,

        -- Data quality flags
        CASE
            WHEN tracking_id IS NULL THEN FALSE
            WHEN origin_zip IS NULL OR LENGTH(TRIM(origin_zip)) < 5 THEN FALSE
            WHEN destination_zip IS NULL OR LENGTH(TRIM(destination_zip)) < 5 THEN FALSE
            WHEN product_class IS NULL THEN FALSE
            WHEN acceptance_date IS NULL THEN FALSE
            WHEN actual_delivery_date IS NOT NULL
                 AND actual_delivery_date < acceptance_date THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN tracking_id IS NULL THEN 'Missing tracking ID'
            WHEN origin_zip IS NULL OR LENGTH(TRIM(origin_zip)) < 5 THEN 'Invalid origin ZIP'
            WHEN destination_zip IS NULL OR LENGTH(TRIM(destination_zip)) < 5 THEN 'Invalid destination ZIP'
            WHEN product_class IS NULL THEN 'Missing product class'
            WHEN acceptance_date IS NULL THEN 'Missing acceptance date'
            WHEN actual_delivery_date IS NOT NULL
                 AND actual_delivery_date < acceptance_date THEN 'Delivery before acceptance'
            ELSE NULL
        END AS validation_errors,

        -- Raw preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        MD5(CONCAT_WS('|',
            COALESCE(CAST(tracking_id AS STRING), ''),
            COALESCE(CAST(origin_zip AS STRING), ''),
            COALESCE(CAST(destination_zip AS STRING), ''),
            COALESCE(CAST(acceptance_date AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('usps', 'delivery_performance') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND tracking_id IS NOT NULL
    AND origin_zip IS NOT NULL
    AND destination_zip IS NOT NULL
    AND acceptance_date IS NOT NULL
