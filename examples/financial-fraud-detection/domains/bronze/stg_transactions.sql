-- ==========================================================================
-- Staging Model: Raw Transactions
-- Source: Bronze layer - raw payment transactions from Event Hubs ingestion
-- All data is synthetic and does not represent real financial activity.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='transaction_id',
    schema='bronze'
) }}

SELECT
    transaction_id,
    account_id,
    CAST(amount AS DECIMAL(18, 2))                  AS amount,
    CAST(currency AS STRING)                        AS currency,
    CAST(merchant_name AS STRING)                   AS merchant_name,
    CAST(merchant_category_code AS STRING)           AS merchant_category_code,
    CAST(channel AS STRING)                         AS channel,
    CAST(transaction_type AS STRING)                AS transaction_type,
    CAST(card_present AS BOOLEAN)                   AS card_present,
    CAST(transaction_ts AS TIMESTAMP)               AS transaction_ts,
    CAST(country_code AS STRING)                    AS country_code,
    CAST(response_code AS STRING)                   AS response_code,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('fraud_raw', 'raw_transactions') }}

{% if is_incremental() %}
WHERE CAST(transaction_ts AS TIMESTAMP) > (
    SELECT MAX(transaction_ts) FROM {{ this }}
)
{% endif %}
