{{
  config(
    materialized='incremental',
    unique_key='invoice_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'finance', 'invoices'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed invoices with validation flags.
  Follows the flag-don't-drop pattern from the shared domain.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_invoices') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY invoice_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['invoice_id']) }} AS invoice_sk,
        CAST(invoice_id AS BIGINT) AS invoice_id,
        CAST(order_id AS BIGINT) AS order_id,
        CAST(customer_id AS BIGINT) AS customer_id,
        CAST(invoice_date AS DATE) AS invoice_date,
        CAST(due_date AS DATE) AS due_date,
        CAST(total_amount AS DECIMAL(18, 2)) AS total_amount,
        CAST(tax_amount AS DECIMAL(18, 2)) AS tax_amount,
        UPPER(TRIM(currency)) AS currency,
        UPPER(TRIM(status)) AS status,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN invoice_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_invoice_id,
        CASE WHEN order_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_order_id,
        CASE WHEN total_amount < 0 THEN TRUE ELSE FALSE END AS _is_negative_amount,
        CASE WHEN due_date IS NULL THEN TRUE ELSE FALSE END AS _is_missing_due_date,
        CASE WHEN due_date < invoice_date THEN TRUE ELSE FALSE END AS _is_due_before_invoice
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_invoice_id OR _is_missing_order_id
        OR _is_negative_amount OR _is_missing_due_date
        OR _is_due_before_invoice
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_invoice_id THEN 'invoice_id null' END,
        CASE WHEN _is_missing_order_id THEN 'order_id null' END,
        CASE WHEN _is_negative_amount THEN 'total_amount negative' END,
        CASE WHEN _is_missing_due_date THEN 'due_date null' END,
        CASE WHEN _is_due_before_invoice THEN 'due_date before invoice_date' END
    ) AS validation_errors
FROM validated
