{{ config(
    materialized='incremental',
    unique_key=['transaction_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'fnb', 'pos', 'transactions'],
    on_schema_change='fail'
) }}

/*
    Bronze Layer — Raw Food & Beverage POS Transactions

    Source: F&B Point of Sale system end-of-day extract.
    Captures dining transactions across all casino venues with
    comp tracking, payment types, and satisfaction scoring.

    All data is ENTIRELY SYNTHETIC. No real transaction data.
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'FNB_POS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Transaction identifiers
        CAST(transaction_id AS STRING) AS transaction_id,
        CAST(player_id AS STRING) AS player_id,

        -- Venue and timing
        TRIM(venue) AS venue,
        CAST(transaction_date AS DATE) AS transaction_date,
        TRIM(meal_period) AS meal_period,

        -- Transaction details
        CAST(items_count AS INT) AS items_count,
        CAST(subtotal AS DECIMAL(10,2)) AS subtotal,
        CAST(tax AS DECIMAL(10,2)) AS tax,
        CAST(total AS DECIMAL(10,2)) AS total,

        -- Payment and comp tracking
        UPPER(TRIM(payment_type)) AS payment_type,
        CAST(comp_value AS DECIMAL(10,2)) AS comp_value,
        CAST(tip_amount AS DECIMAL(10,2)) AS tip_amount,

        -- Guest information
        CAST(party_size AS INT) AS party_size,
        CAST(satisfaction_score AS INT) AS satisfaction_score,

        -- Data quality flags
        CASE
            WHEN transaction_id IS NULL THEN FALSE
            WHEN transaction_date IS NULL THEN FALSE
            WHEN transaction_date > CURRENT_DATE() THEN FALSE
            WHEN venue IS NULL OR TRIM(venue) = '' THEN FALSE
            WHEN total IS NULL OR total < 0 THEN FALSE
            WHEN satisfaction_score IS NOT NULL AND (satisfaction_score < 1 OR satisfaction_score > 5) THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN transaction_id IS NULL THEN 'Missing transaction_id'
            WHEN transaction_date IS NULL THEN 'Missing transaction_date'
            WHEN transaction_date > CURRENT_DATE() THEN 'Future transaction_date'
            WHEN venue IS NULL OR TRIM(venue) = '' THEN 'Missing venue'
            WHEN total IS NULL OR total < 0 THEN 'Invalid total'
            WHEN satisfaction_score IS NOT NULL AND (satisfaction_score < 1 OR satisfaction_score > 5) THEN 'Invalid satisfaction_score'
            ELSE NULL
        END AS validation_errors,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(transaction_id AS STRING), ''),
            COALESCE(CAST(player_id AS STRING), ''),
            COALESCE(CAST(transaction_date AS STRING), ''),
            COALESCE(CAST(total AS STRING), '')
        )) AS record_hash,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('casino', 'fnb_transactions') }}

    {% if is_incremental() %}
        WHERE ingestion_timestamp > (SELECT MAX(ingestion_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE transaction_id IS NOT NULL
