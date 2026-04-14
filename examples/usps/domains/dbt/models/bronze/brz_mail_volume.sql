{{ config(
    materialized='incremental',
    unique_key=['facility_id', 'product_class', 'volume_date'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'usps', 'mail_volume']
) }}

/*
    Bronze Layer: Mail Volume
    Source: USPS mail and parcel volume reporting
    Description: Raw daily mail volume counts by facility, product class, and
                 mail shape. Used for volume forecasting, capacity planning,
                 and seasonal analysis.

    Grain: One row per facility + product class + volume date
    Update frequency: Daily
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'USPS_VOLUME' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Identifiers
        CAST(facility_id AS STRING) AS facility_id,
        CAST(facility_name AS STRING) AS facility_name,
        CAST(facility_type AS STRING) AS facility_type,
        CAST(district AS STRING) AS district,
        CAST(region AS STRING) AS region,
        CAST(state AS STRING) AS state,

        -- Product classification
        CAST(product_class AS STRING) AS product_class,
        CAST(mail_shape AS STRING) AS mail_shape,

        -- Temporal
        TRY_CAST(volume_date AS DATE) AS volume_date,
        CAST(volume_year AS INT) AS volume_year,
        CAST(volume_month AS INT) AS volume_month,
        CAST(volume_day_of_week AS INT) AS volume_day_of_week,

        -- Volume counts
        CAST(inbound_pieces AS BIGINT) AS inbound_pieces,
        CAST(outbound_pieces AS BIGINT) AS outbound_pieces,
        CAST(total_pieces AS BIGINT) AS total_pieces,
        CAST(revenue_pieces AS BIGINT) AS revenue_pieces,

        -- Weight
        CAST(total_weight_lbs AS DECIMAL(14, 2)) AS total_weight_lbs,
        CAST(avg_weight_per_piece_oz AS DECIMAL(8, 2)) AS avg_weight_per_piece_oz,

        -- Revenue
        CAST(postage_revenue AS DECIMAL(12, 2)) AS postage_revenue,
        CAST(avg_revenue_per_piece AS DECIMAL(8, 4)) AS avg_revenue_per_piece,

        -- Comparison metrics
        CAST(volume_prior_year_same_day AS BIGINT) AS volume_prior_year_same_day,
        CAST(volume_prior_week AS BIGINT) AS volume_prior_week,

        -- Flags
        CAST(is_holiday AS BOOLEAN) AS is_holiday,
        CAST(is_business_day AS BOOLEAN) AS is_business_day,

        -- Data quality flags
        CASE
            WHEN facility_id IS NULL THEN FALSE
            WHEN volume_date IS NULL THEN FALSE
            WHEN product_class IS NULL THEN FALSE
            WHEN total_pieces IS NOT NULL AND total_pieces < 0 THEN FALSE
            WHEN volume_year IS NOT NULL AND (volume_year < 2000 OR volume_year > YEAR(CURRENT_DATE()) + 1) THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN facility_id IS NULL THEN 'Missing facility ID'
            WHEN volume_date IS NULL THEN 'Missing volume date'
            WHEN product_class IS NULL THEN 'Missing product class'
            WHEN total_pieces IS NOT NULL AND total_pieces < 0 THEN 'Negative volume'
            WHEN volume_year IS NOT NULL AND volume_year < 2000 THEN 'Year out of range'
            ELSE NULL
        END AS validation_errors,

        -- Raw preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        MD5(CONCAT_WS('|',
            COALESCE(CAST(facility_id AS STRING), ''),
            COALESCE(CAST(product_class AS STRING), ''),
            COALESCE(CAST(volume_date AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('usps', 'mail_volume') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND facility_id IS NOT NULL
    AND volume_date IS NOT NULL
    AND product_class IS NOT NULL
