-- ==========================================================================
-- Staging Model: Raw Accounts
-- Source: Bronze layer - customer account master from core banking extract
-- All data is synthetic and does not represent real financial accounts.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='account_id',
    schema='bronze'
) }}

SELECT
    account_id,
    customer_id,
    CAST(account_type AS STRING)                    AS account_type,
    CAST(open_date AS DATE)                         AS open_date,
    CAST(status AS STRING)                          AS status,
    CAST(credit_limit AS DECIMAL(18, 2))            AS credit_limit,
    CAST(billing_country AS STRING)                 AS billing_country,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('fraud_raw', 'raw_accounts') }}

{% if is_incremental() %}
WHERE CAST(open_date AS DATE) > (
    SELECT MAX(open_date) FROM {{ this }}
)
{% endif %}
