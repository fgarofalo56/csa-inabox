{{ config(materialized='incremental', unique_key='order_id') }}
SELECT
    order_id,
    customer_id,
    product_id,
    order_date,
    ship_date,
    quantity,
    unit_price,
    discount_pct,
    _ingested_at
FROM {{ ref('bronze_sales') }}
WHERE order_id IS NOT NULL
  AND quantity > 0
  AND unit_price >= 0
{% if is_incremental() %}
  AND _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
