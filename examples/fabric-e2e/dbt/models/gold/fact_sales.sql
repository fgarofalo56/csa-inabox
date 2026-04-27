{{ config(materialized='incremental', unique_key='sales_key') }}
SELECT
    ROW_NUMBER() OVER (ORDER BY s.order_id, s._ingested_at) AS sales_key,
    c.customer_key,
    p.product_key,
    od.date_key AS order_date_key,
    sd.date_key AS ship_date_key,
    s.order_id,
    s.quantity,
    s.unit_price,
    s.discount_pct,
    CAST(s.quantity * s.unit_price * (1 - s.discount_pct) AS DECIMAL(18,2)) AS extended_amount,
    CAST(s.quantity * p.list_price * 0.55 AS DECIMAL(18,2)) AS cost_amount,
    CAST(s.quantity * s.unit_price * (1 - s.discount_pct) - s.quantity * p.list_price * 0.55 AS DECIMAL(18,2)) AS margin_amount
FROM {{ ref('silver_sales') }} s
JOIN {{ ref('dim_customer') }} c ON c.customer_id = s.customer_id AND c.is_current
JOIN {{ ref('dim_product')  }} p ON p.product_id  = s.product_id  AND p.is_current
JOIN {{ ref('dim_date')     }} od ON od.date = s.order_date
JOIN {{ ref('dim_date')     }} sd ON sd.date = s.ship_date
{% if is_incremental() %}
WHERE s._ingested_at > (SELECT MAX(s._ingested_at)
                        FROM {{ ref('silver_sales') }} s
                        JOIN {{ this }} f ON f.order_id = s.order_id)
{% endif %}
