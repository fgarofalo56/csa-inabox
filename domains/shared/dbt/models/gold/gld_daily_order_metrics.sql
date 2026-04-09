{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'orders', 'metrics']
  )
}}

/*
  Gold: Daily order metrics
  Business-ready aggregations for dashboards and reporting.
*/

WITH orders AS (
    SELECT * FROM {{ ref('slv_orders') }}
    WHERE _is_negative_amount = FALSE
      AND _is_future_date = FALSE
),

daily_metrics AS (
    SELECT
        order_date,
        COUNT(DISTINCT order_id) AS total_orders,
        COUNT(DISTINCT customer_id) AS unique_customers,
        SUM(total_amount) AS total_revenue,
        AVG(total_amount) AS avg_order_value,
        MIN(total_amount) AS min_order_value,
        MAX(total_amount) AS max_order_value,

        -- Status breakdown
        COUNT(CASE WHEN status = 'DELIVERED' THEN 1 END) AS delivered_orders,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) AS cancelled_orders,
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END) AS pending_orders,

        -- Derived metrics
        ROUND(
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0),
            2
        ) AS cancellation_rate_pct,

        current_timestamp() AS _dbt_loaded_at

    FROM orders
    GROUP BY order_date
)

SELECT * FROM daily_metrics
ORDER BY order_date DESC
