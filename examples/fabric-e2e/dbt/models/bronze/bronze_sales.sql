{{ config(materialized='view') }}
SELECT
    CAST(order_id AS VARCHAR)           AS order_id,
    CAST(customer_id AS VARCHAR)        AS customer_id,
    CAST(product_id AS VARCHAR)         AS product_id,
    CAST(order_date AS DATE)            AS order_date,
    CAST(ship_date AS DATE)             AS ship_date,
    CAST(quantity AS INTEGER)           AS quantity,
    CAST(unit_price AS DECIMAL(18,2))   AS unit_price,
    CAST(discount_pct AS DECIMAL(5,4))  AS discount_pct,
    CURRENT_TIMESTAMP                   AS _ingested_at
FROM {{ source('bronze', 'sales_raw') }}
