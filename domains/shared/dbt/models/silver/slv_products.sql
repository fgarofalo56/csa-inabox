{{
  config(
    materialized='incremental',
    unique_key='product_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'products'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed products.

  Applies type casting, standardization, and validation flags following
  the same flag-don't-drop pattern as slv_orders and slv_customers
  (Archon tasks 310b5446 + 0ac384b5).  Gold models filter on
  ``is_valid = true``.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_products') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY product_id
            ORDER BY _ingested_at DESC
        ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['product_id']) }} AS product_sk,

        CAST(product_id AS BIGINT) AS product_id,
        TRIM(product_name) AS product_name,
        TRIM(UPPER(category)) AS category,
        CAST(unit_price AS DECIMAL(18, 2)) AS unit_price,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN product_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_product_id,
        CASE WHEN product_name IS NULL OR TRIM(product_name) = '' THEN TRUE ELSE FALSE END AS _is_missing_name,
        CASE WHEN unit_price IS NULL OR unit_price <= 0 THEN TRUE ELSE FALSE END AS _is_invalid_price,
        CASE WHEN category IS NULL OR TRIM(category) = '' THEN TRUE ELSE FALSE END AS _is_missing_category
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_product_id
        OR _is_missing_name
        OR _is_invalid_price
        OR _is_missing_category
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_product_id THEN 'product_id null' END,
        CASE WHEN _is_missing_name THEN 'product_name missing' END,
        CASE WHEN _is_invalid_price THEN 'unit_price invalid' END,
        CASE WHEN _is_missing_category THEN 'category missing' END
    ) AS validation_errors
FROM validated
