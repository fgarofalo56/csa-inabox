{{ config(materialized='view') }}
SELECT
    CAST(product_id AS VARCHAR)         AS product_id,
    CAST(product_name AS VARCHAR)       AS product_name,
    CAST(category AS VARCHAR)           AS category,
    CAST(subcategory AS VARCHAR)        AS subcategory,
    CAST(list_price AS DECIMAL(18,2))   AS list_price,
    CAST(cost_price AS DECIMAL(18,2))   AS cost_price,
    CURRENT_TIMESTAMP                   AS _ingested_at
FROM {{ source('bronze', 'products_raw') }}
