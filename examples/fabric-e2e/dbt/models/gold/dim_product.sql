{{ config(materialized='incremental', unique_key='product_key') }}
SELECT
    ROW_NUMBER() OVER (ORDER BY product_id, _ingested_at) AS product_key,
    product_id,
    product_name,
    category,
    subcategory,
    list_price,
    _ingested_at AS valid_from,
    CAST(NULL AS TIMESTAMP) AS valid_to,
    TRUE AS is_current
FROM {{ ref('silver_products') }}
{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(valid_from) FROM {{ this }})
{% endif %}
