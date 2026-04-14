{{ config(
    materialized='incremental',
    unique_key='delivery_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'delivery_performance', 'cleaned']
) }}

/*
    Silver Layer: Delivery Performance (Cleansed & Conformed)
    Description: Cleaned delivery records with standardized product classes,
                 calculated on-time flag, delivery speed metrics, and
                 geographic enrichment. Enables route-level and ZIP-level
                 performance analysis.

    Transformations:
      - Product class standardization
      - On-time delivery flag (actual vs. service standard)
      - Delivery speed calculation (business days)
      - ZIP code validation and standardization
      - Route-level aggregation readiness
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_delivery_performance') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|', tracking_id, CAST(acceptance_date AS STRING))) AS delivery_sk,

        -- Identifiers
        tracking_id,
        carrier_route,
        delivery_unit,

        -- Geographic standardization (5-digit ZIP)
        LPAD(LEFT(TRIM(origin_zip), 5), 5, '0') AS origin_zip,
        UPPER(TRIM(origin_city)) AS origin_city,
        UPPER(TRIM(origin_state)) AS origin_state,
        LPAD(LEFT(TRIM(destination_zip), 5), 5, '0') AS destination_zip,
        UPPER(TRIM(destination_city)) AS destination_city,
        UPPER(TRIM(destination_state)) AS destination_state,
        UPPER(TRIM(district)) AS district,
        UPPER(TRIM(region)) AS region,

        -- Derive 3-digit ZIP prefix (Sectional Center Facility code)
        LEFT(LPAD(LEFT(TRIM(origin_zip), 5), 5, '0'), 3) AS origin_scf,
        LEFT(LPAD(LEFT(TRIM(destination_zip), 5), 5, '0'), 3) AS destination_scf,

        -- Same-SCF flag (intra-facility routing)
        CASE
            WHEN LEFT(TRIM(origin_zip), 3) = LEFT(TRIM(destination_zip), 3) THEN TRUE
            ELSE FALSE
        END AS is_intra_scf,

        -- Same-state flag
        CASE
            WHEN UPPER(TRIM(origin_state)) = UPPER(TRIM(destination_state)) THEN TRUE
            ELSE FALSE
        END AS is_intra_state,

        -- Product class standardization
        CASE UPPER(TRIM(product_class))
            WHEN 'FC' THEN 'FIRST_CLASS'
            WHEN 'FIRST CLASS' THEN 'FIRST_CLASS'
            WHEN 'FIRST_CLASS' THEN 'FIRST_CLASS'
            WHEN 'PM' THEN 'PRIORITY'
            WHEN 'PRIORITY' THEN 'PRIORITY'
            WHEN 'PRIORITY MAIL' THEN 'PRIORITY'
            WHEN 'PME' THEN 'PRIORITY_EXPRESS'
            WHEN 'PRIORITY EXPRESS' THEN 'PRIORITY_EXPRESS'
            WHEN 'PRIORITY_EXPRESS' THEN 'PRIORITY_EXPRESS'
            WHEN 'PS' THEN 'PARCEL_SELECT'
            WHEN 'PARCEL SELECT' THEN 'PARCEL_SELECT'
            WHEN 'PARCEL_SELECT' THEN 'PARCEL_SELECT'
            WHEN 'MM' THEN 'MEDIA_MAIL'
            WHEN 'MEDIA MAIL' THEN 'MEDIA_MAIL'
            WHEN 'MEDIA_MAIL' THEN 'MEDIA_MAIL'
            WHEN 'MKT' THEN 'MARKETING_MAIL'
            WHEN 'MARKETING MAIL' THEN 'MARKETING_MAIL'
            WHEN 'MARKETING_MAIL' THEN 'MARKETING_MAIL'
            WHEN 'PER' THEN 'PERIODICALS'
            WHEN 'PERIODICALS' THEN 'PERIODICALS'
            ELSE UPPER(TRIM(product_class))
        END AS product_class,

        service_type,
        mail_shape,
        weight_oz,

        -- Temporal
        acceptance_datetime,
        acceptance_date,
        YEAR(acceptance_date) AS acceptance_year,
        MONTH(acceptance_date) AS acceptance_month,
        DAYOFWEEK(acceptance_date) AS acceptance_dow,
        expected_delivery_date,
        actual_delivery_date,
        actual_delivery_datetime,

        -- Delivery status standardization
        UPPER(TRIM(delivery_status)) AS delivery_status,

        -- Service standard (days)
        COALESCE(service_standard_days,
            CASE UPPER(TRIM(product_class))
                WHEN 'FIRST_CLASS' THEN {{ var('first_class_standard_days') }}
                WHEN 'FC' THEN {{ var('first_class_standard_days') }}
                WHEN 'PRIORITY' THEN {{ var('priority_standard_days') }}
                WHEN 'PM' THEN {{ var('priority_standard_days') }}
                WHEN 'PRIORITY_EXPRESS' THEN 1
                WHEN 'PME' THEN 1
                WHEN 'PARCEL_SELECT' THEN {{ var('parcel_standard_days') }}
                WHEN 'PS' THEN {{ var('parcel_standard_days') }}
                WHEN 'MEDIA_MAIL' THEN {{ var('media_standard_days') }}
                WHEN 'MM' THEN {{ var('media_standard_days') }}
                ELSE 5
            END
        ) AS service_standard_days,

        -- Delivery time calculation
        delivery_time_days,

        -- Calculated delivery time if not provided
        CASE
            WHEN actual_delivery_date IS NOT NULL AND acceptance_date IS NOT NULL
            THEN DATEDIFF(actual_delivery_date, acceptance_date)
            ELSE delivery_time_days
        END AS calculated_delivery_days,

        delivery_attempt_count,

        -- Facility routing
        origin_facility_id,
        destination_facility_id,
        processing_facility_id,
        carrier_type,
        delivery_method,

        -- On-time delivery flag
        CASE
            WHEN actual_delivery_date IS NULL THEN NULL  -- Not yet delivered
            WHEN actual_delivery_date <= expected_delivery_date THEN TRUE
            WHEN DATEDIFF(actual_delivery_date, acceptance_date) <=
                 COALESCE(service_standard_days,
                    CASE UPPER(TRIM(product_class))
                        WHEN 'FIRST_CLASS' THEN {{ var('first_class_standard_days') }}
                        WHEN 'PRIORITY' THEN {{ var('priority_standard_days') }}
                        WHEN 'PRIORITY_EXPRESS' THEN 1
                        WHEN 'PARCEL_SELECT' THEN {{ var('parcel_standard_days') }}
                        WHEN 'MEDIA_MAIL' THEN {{ var('media_standard_days') }}
                        ELSE 5
                    END
                 ) THEN TRUE
            ELSE FALSE
        END AS is_on_time,

        -- Days late (positive = late, negative = early)
        CASE
            WHEN actual_delivery_date IS NOT NULL AND expected_delivery_date IS NOT NULL
            THEN DATEDIFF(actual_delivery_date, expected_delivery_date)
            ELSE NULL
        END AS days_from_expected,

        -- Source tracking
        source_system,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
