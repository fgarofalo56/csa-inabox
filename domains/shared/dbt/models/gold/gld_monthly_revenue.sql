{{
  config(
    materialized='incremental',
    unique_key='month_key',
    incremental_strategy='merge',
    partition_by=['revenue_year'],
    file_format='delta',
    tags=['gold', 'revenue', 'metrics'],
    on_schema_change='fail'
  )
}}

/*
  Gold: Monthly revenue metrics by region.

  Aggregates order data into monthly cohorts with region and status
  breakdowns for executive dashboards and financial reporting.
*/

WITH fact AS (
    SELECT * FROM {{ ref('fact_orders') }}
    {% if is_incremental() %}
    WHERE _dbt_refreshed_at > (SELECT MAX(_dbt_refreshed_at) FROM {{ this }})
    {% endif %}
),

customers AS (
    SELECT customer_id, customer_sk
    FROM {{ ref('dim_customers') }}
),

monthly AS (
    SELECT
        -- Composite key for merge (includes state to match GROUP BY grain)
        CONCAT(
            CAST(YEAR(f.order_date) AS STRING), '-',
            LPAD(CAST(MONTH(f.order_date) AS STRING), 2, '0'), '-',
            COALESCE(f.customer_country, 'UNKNOWN'), '-',
            COALESCE(f.customer_state, 'UNKNOWN')
        ) AS month_key,

        YEAR(f.order_date) AS revenue_year,
        MONTH(f.order_date) AS revenue_month,
        DATE_TRUNC('month', f.order_date) AS revenue_period,
        COALESCE(f.customer_country, 'UNKNOWN') AS country,
        COALESCE(f.customer_state, 'UNKNOWN') AS state,

        -- Revenue metrics
        COUNT(DISTINCT f.order_id) AS total_orders,
        COUNT(DISTINCT f.customer_id) AS unique_customers,
        SUM(f.total_amount) AS gross_revenue,
        SUM(CASE WHEN f.is_cancelled = 0 AND f.is_returned = 0 THEN f.total_amount ELSE 0 END) AS net_revenue,
        SUM(CASE WHEN f.is_returned = 1 THEN f.total_amount ELSE 0 END) AS returned_revenue,
        SUM(CASE WHEN f.is_cancelled = 1 THEN f.total_amount ELSE 0 END) AS cancelled_revenue,
        AVG(f.total_amount) AS avg_order_value,

        -- Status breakdown
        SUM(f.is_delivered) AS delivered_orders,
        SUM(f.is_cancelled) AS cancelled_orders,
        SUM(f.is_returned) AS returned_orders,
        SUM(f.is_in_progress) AS in_progress_orders,

        -- Derived rates
        ROUND(
            SUM(f.is_cancelled) * 100.0 / NULLIF(COUNT(DISTINCT f.order_id), 0), 2
        ) AS cancellation_rate_pct,
        ROUND(
            SUM(f.is_returned) * 100.0 / NULLIF(COUNT(DISTINCT f.order_id), 0), 2
        ) AS return_rate_pct,

        current_timestamp() AS _dbt_refreshed_at

    FROM fact f
    GROUP BY 1, 2, 3, 4, 5, 6
)

SELECT * FROM monthly
