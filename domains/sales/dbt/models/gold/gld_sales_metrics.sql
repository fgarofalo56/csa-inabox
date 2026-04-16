{{
    config(
        materialized='incremental',
        unique_key=['order_date', 'sales_region', 'sales_channel'],
        incremental_strategy='merge',
        file_format='delta',
        tags=['gold', 'sales', 'metrics'],
        on_schema_change='fail'
    )
}}

{#
    Daily sales metrics by region and channel.
    Published as a data product for downstream consumers.
#}

with orders as (
    select * from {{ ref('slv_sales_orders') }}
    where is_valid = true
    {% if is_incremental() %}
      and order_date > (select max(order_date) from {{ this }})
    {% endif %}
),

daily_metrics as (
    select
        order_date,
        sales_region,
        sales_channel,

        count(distinct order_id) as total_orders,
        count(distinct customer_id) as unique_customers,
        sum(line_total) as total_revenue,
        avg(line_total) as avg_line_value,
        sum(quantity) as total_units_sold,
        avg(unit_price) as avg_unit_price,

        -- Product diversity
        count(distinct product_id) as unique_products_sold

    from orders
    group by 1, 2, 3
)

select
    *,
    total_revenue / nullif(total_orders, 0) as revenue_per_order,
    total_units_sold / nullif(total_orders, 0) as units_per_order,
    now() as _dbt_refreshed_at
from daily_metrics
