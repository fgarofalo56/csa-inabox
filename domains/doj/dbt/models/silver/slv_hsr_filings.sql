{{
  config(
    materialized='incremental',
    unique_key='filing_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'doj', 'hsr', 'filings'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed HSR filings with validation flags.
  Follows the flag-don't-drop pattern from the shared domain.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_hsr_filings') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY filing_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['filing_id']) }} AS filing_sk,
        CAST(filing_id AS BIGINT) AS filing_id,
        CAST(fiscal_year AS INT) AS fiscal_year,
        TRIM(transaction_id) AS transaction_id,
        TRIM(acquiring_party) AS acquiring_party,
        TRIM(target_party) AS target_party,
        CAST(transaction_value AS DECIMAL(18, 2)) AS transaction_value,
        CAST(filing_date AS DATE) AS filing_date,
        TRIM(industry_naics_code) AS industry_naics_code,
        TRIM(industry_description) AS industry_description,
        CAST(filing_fee AS DECIMAL(18, 2)) AS filing_fee,
        UPPER(TRIM(review_status)) AS review_status,
        CAST(review_days AS INT) AS review_days,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN filing_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_filing_id,
        CASE WHEN transaction_value IS NULL OR transaction_value <= 0 THEN TRUE ELSE FALSE END AS _is_invalid_transaction_value,
        CASE WHEN filing_date IS NULL THEN TRUE ELSE FALSE END AS _is_missing_filing_date,
        CASE WHEN filing_date > current_date() THEN TRUE ELSE FALSE END AS _is_future_filing_date,
        CASE WHEN acquiring_party IS NULL OR acquiring_party = '' THEN TRUE ELSE FALSE END AS _is_missing_acquiring_party,
        CASE WHEN target_party IS NULL OR target_party = '' THEN TRUE ELSE FALSE END AS _is_missing_target_party,
        CASE WHEN review_days IS NOT NULL AND review_days < 0 THEN TRUE ELSE FALSE END AS _is_negative_review_days
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_filing_id OR _is_invalid_transaction_value OR _is_missing_filing_date
        OR _is_future_filing_date OR _is_missing_acquiring_party
        OR _is_missing_target_party OR _is_negative_review_days
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_filing_id THEN 'filing_id null' END,
        CASE WHEN _is_invalid_transaction_value THEN 'transaction_value null/negative' END,
        CASE WHEN _is_missing_filing_date THEN 'filing_date null' END,
        CASE WHEN _is_future_filing_date THEN 'filing_date in future' END,
        CASE WHEN _is_missing_acquiring_party THEN 'acquiring_party null/empty' END,
        CASE WHEN _is_missing_target_party THEN 'target_party null/empty' END,
        CASE WHEN _is_negative_review_days THEN 'review_days negative' END
    ) AS validation_errors
FROM validated