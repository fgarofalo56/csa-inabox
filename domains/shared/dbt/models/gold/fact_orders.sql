{{
  config(
    materialized='incremental',
    unique_key='order_sk',
    incremental_strategy='merge',
    partition_by=['order_date'] if target.type != 'duckdb' else none,
    clustered_by=['customer_id'] if target.type != 'duckdb' else none,
    file_format='delta' if target.type != 'duckdb' else none,
    tags=['gold', 'orders', 'fact'],
    on_schema_change='fail'
  )
}}

/*
  Gold: Fact orders.

  Grain: one row per order.  Joins Silver orders with customer and
  product dimensions for star-schema analytics.  Gold filters to valid
  Silver rows only.
*/

WITH orders AS (
    SELECT * FROM {{ ref('slv_orders') }}
    WHERE is_valid = TRUE
    {% if is_incremental() %}
    AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

customers AS (
    SELECT
        customer_sk,
        customer_id,
        country_code,
        state_code
    FROM {{ ref('dim_customers') }}
),

final AS (
    SELECT
        o.order_sk,
        o.order_id,
        o.order_date,
        o.customer_id,
        c.customer_sk,
        c.country_code AS customer_country,
        c.state_code AS customer_state,

        o.total_amount,
        o.status AS order_status,

        -- Status flags for aggregation
        CASE WHEN o.status = 'DELIVERED' THEN 1 ELSE 0 END AS is_delivered,
        CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END AS is_cancelled,
        CASE WHEN o.status = 'RETURNED' THEN 1 ELSE 0 END AS is_returned,
        CASE WHEN o.status IN ('PENDING', 'CONFIRMED', 'SHIPPED') THEN 1 ELSE 0 END AS is_in_progress,

        -- Time dimensions
        {{ year_of('o.order_date') }} AS order_year,
        {{ month_of('o.order_date') }} AS order_month,
        {{ quarter_of('o.order_date') }} AS order_quarter,
        {{ day_of_week('o.order_date') }} AS order_day_of_week,

        o._dbt_loaded_at,
        now() AS _dbt_refreshed_at

    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.customer_id
)

SELECT * FROM final
