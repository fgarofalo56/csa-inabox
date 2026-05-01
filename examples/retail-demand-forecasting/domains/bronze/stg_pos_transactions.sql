-- ==========================================================================
-- Staging Model: Raw POS Transactions
-- Source: Bronze layer - raw CSV/Parquet files from store POS systems
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='transaction_id',
    schema='bronze'
) }}

SELECT
    CAST(transaction_id AS STRING)                  AS transaction_id,
    CAST(store_id AS STRING)                        AS store_id,
    CAST(sku AS STRING)                             AS sku,
    CAST(quantity AS INT)                            AS quantity,
    CAST(unit_price AS DECIMAL(10,2))               AS unit_price,
    CAST(discount_amount AS DECIMAL(10,2))          AS discount_amount,
    CAST(transaction_timestamp AS TIMESTAMP)        AS transaction_timestamp,
    CAST(payment_method AS STRING)                  AS payment_method,
    CAST(cashier_id AS STRING)                      AS cashier_id,
    ROUND(
        CAST(quantity AS INT) * CAST(unit_price AS DECIMAL(10,2))
        - COALESCE(CAST(discount_amount AS DECIMAL(10,2)), 0),
        2
    )                                               AS line_total,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('pos_raw', 'raw_pos_transactions') }}

{% if is_incremental() %}
WHERE CAST(transaction_timestamp AS TIMESTAMP) > (
    SELECT MAX(transaction_timestamp) FROM {{ this }}
)
{% endif %}
