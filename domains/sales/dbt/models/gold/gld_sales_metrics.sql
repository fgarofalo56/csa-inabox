{{
    config(
        materialized='table',
        file_format='delta',
        tags=['gold', 'sales', 'metrics']
    )
}}

{#
    Daily sales metrics by region and channel.
    Published as a data product for downstream consumers.
#}

with orders as (
    select * from {{ ref('slv_sales_orders') }}
    where not _is_negative_price
      and not _is_future_date
      and not _is_invalid_quantity
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
    current_timestamp() as _dbt_refreshed_at
from daily_metrics
