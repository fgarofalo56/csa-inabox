{{
  config(
    materialized='incremental',
    unique_key='review_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'doj', 'merger', 'reviews'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed merger reviews with validation flags.
  Follows the flag-don't-drop pattern from the shared domain.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_merger_reviews') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY review_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['review_id']) }} AS review_sk,
        CAST(review_id AS BIGINT) AS review_id,
        CAST(fiscal_year AS INT) AS fiscal_year,
        TRIM(transaction_id) AS transaction_id,
        TRIM(acquiring_party) AS acquiring_party,
        TRIM(target_party) AS target_party,
        CAST(transaction_value AS DECIMAL(18, 2)) AS transaction_value,
        UPPER(TRIM(industry_sector)) AS industry_sector,
        UPPER(TRIM(review_outcome)) AS review_outcome,
        CAST(hhi_pre_merger AS INT) AS hhi_pre_merger,
        CAST(hhi_post_merger AS INT) AS hhi_post_merger,
        CAST(hhi_delta AS INT) AS hhi_delta,
        TRIM(market_definition) AS market_definition,
        CAST(review_start_date AS DATE) AS review_start_date,
        CAST(review_end_date AS DATE) AS review_end_date,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN review_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_review_id,
        CASE WHEN transaction_value IS NULL OR transaction_value <= 0 THEN TRUE ELSE FALSE END AS _is_invalid_transaction_value,
        CASE WHEN acquiring_party IS NULL OR acquiring_party = '' THEN TRUE ELSE FALSE END AS _is_missing_acquiring_party,
        CASE WHEN target_party IS NULL OR target_party = '' THEN TRUE ELSE FALSE END AS _is_missing_target_party,
        CASE WHEN hhi_pre_merger IS NOT NULL AND (hhi_pre_merger < 0 OR hhi_pre_merger > 10000) THEN TRUE ELSE FALSE END AS _is_invalid_hhi_pre,
        CASE WHEN hhi_post_merger IS NOT NULL AND (hhi_post_merger < 0 OR hhi_post_merger > 10000) THEN TRUE ELSE FALSE END AS _is_invalid_hhi_post,
        CASE WHEN review_end_date IS NOT NULL AND review_start_date IS NOT NULL AND review_end_date < review_start_date THEN TRUE ELSE FALSE END AS _is_end_before_start
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_review_id OR _is_invalid_transaction_value OR _is_missing_acquiring_party
        OR _is_missing_target_party OR _is_invalid_hhi_pre
        OR _is_invalid_hhi_post OR _is_end_before_start
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_review_id THEN 'review_id null' END,
        CASE WHEN _is_invalid_transaction_value THEN 'transaction_value null/negative' END,
        CASE WHEN _is_missing_acquiring_party THEN 'acquiring_party null/empty' END,
        CASE WHEN _is_missing_target_party THEN 'target_party null/empty' END,
        CASE WHEN _is_invalid_hhi_pre THEN 'hhi_pre_merger out of range (0-10000)' END,
        CASE WHEN _is_invalid_hhi_post THEN 'hhi_post_merger out of range (0-10000)' END,
        CASE WHEN _is_end_before_start THEN 'review_end_date before review_start_date' END
    ) AS validation_errors
FROM validated