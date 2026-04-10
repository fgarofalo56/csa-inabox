{{
  config(
    materialized='incremental',
    unique_key='payment_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'finance', 'payments']
  )
}}

/*
  Silver: Conformed payments with validation flags.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_payments') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY payment_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['payment_id']) }} AS payment_sk,
        CAST(payment_id AS BIGINT) AS payment_id,
        CAST(invoice_id AS BIGINT) AS invoice_id,
        CAST(payment_date AS DATE) AS payment_date,
        CAST(amount AS DECIMAL(18, 2)) AS amount,
        LOWER(TRIM(payment_method)) AS payment_method,
        TRIM(reference_number) AS reference_number,
        _ingested_at,
        current_timestamp() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN payment_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_payment_id,
        CASE WHEN invoice_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_invoice_id,
        CASE WHEN amount <= 0 THEN TRUE ELSE FALSE END AS _is_invalid_amount,
        CASE WHEN payment_date IS NULL THEN TRUE ELSE FALSE END AS _is_missing_date
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_payment_id OR _is_missing_invoice_id
        OR _is_invalid_amount OR _is_missing_date
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_payment_id THEN 'payment_id null' END,
        CASE WHEN _is_missing_invoice_id THEN 'invoice_id null' END,
        CASE WHEN _is_invalid_amount THEN 'amount invalid' END,
        CASE WHEN _is_missing_date THEN 'payment_date null' END
    ) AS validation_errors
FROM validated
