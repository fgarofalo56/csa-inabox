{{ config(materialized='incremental', unique_key='product_id') }}
SELECT
    product_id,
    product_name,
    category,
    subcategory,
    list_price,
    cost_price,
    _ingested_at
FROM {{ ref('bronze_products') }}
WHERE product_id IS NOT NULL
{% if is_incremental() %}
  AND _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
