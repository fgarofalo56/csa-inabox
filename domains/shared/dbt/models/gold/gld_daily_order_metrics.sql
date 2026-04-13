{{
  config(
    materialized='incremental',
    unique_key='order_date',
    incremental_strategy='merge',
    partition_by=['order_date'],
    file_format='delta',
    tags=['gold', 'orders', 'metrics']
  )
}}

/*
  Gold: Daily order metrics
  Business-ready aggregations for dashboards and reporting.
*/

-- Gold filters to valid Silver rows only. The Silver layer keeps bad
-- records with ``is_valid = false`` + ``validation_errors`` per Archon
-- task 0ac384b5, so quality monitoring can count drops; here in Gold we
-- just take the clean subset for business-facing metrics.
WITH orders AS (
    SELECT * FROM {{ ref('slv_orders') }}
    WHERE is_valid = TRUE
    {% if is_incremental() %}
      AND order_date > (SELECT MAX(order_date) FROM {{ this }})
    {% endif %}
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
