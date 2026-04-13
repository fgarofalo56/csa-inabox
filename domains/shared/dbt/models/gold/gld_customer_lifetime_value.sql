{{
    config(
        materialized='incremental',
        unique_key='customer_id',
        incremental_strategy='merge',
        partition_by=['customer_segment'],
        clustered_by=['value_tier'],
        file_format='delta',
        tags=['gold', 'customers', 'metrics']
    )
}}

{#
    Customer Lifetime Value (CLV) metrics.
    Combines customer and order data to compute per-customer aggregates
    for analytics and reporting.
#}

-- Gold filters to valid Silver rows only.  The Silver layer keeps bad
-- records with ``is_valid = false`` + ``validation_errors`` per Archon
-- task 0ac384b5, so quality monitoring can count drops; here in Gold we
-- just take the clean subset for business-facing metrics.
with customers as (
    select * from {{ ref('slv_customers') }}
    where is_valid = true
),

orders as (
    select * from {{ ref('slv_orders') }}
    where is_valid = true
    {% if is_incremental() %}
      and _dbt_loaded_at > (select max(_dbt_refreshed_at) from {{ this }})
    {% endif %}
),

customer_orders as (
    select
        c.customer_id,
        c.first_name,
        c.last_name,
        c.email,
        c.city,
        c.state_code,
        c.country_code,
        c.created_at as customer_since,

        -- Order metrics
        count(distinct o.order_id) as total_orders,
        coalesce(sum(o.total_amount), 0) as lifetime_revenue,
        coalesce(avg(o.total_amount), 0) as avg_order_value,
        min(o.order_date) as first_order_date,
        max(o.order_date) as last_order_date,
        count(distinct date_trunc('month', o.order_date)) as active_months,

        -- Status breakdown
        count(case when o.status = 'DELIVERED' then 1 end) as completed_orders,
        count(case when o.status = 'CANCELLED' then 1 end) as cancelled_orders,
        count(case when o.status = 'RETURNED' then 1 end) as returned_orders

    from customers c
    left join orders o on c.customer_id = o.customer_id
    group by 1, 2, 3, 4, 5, 6, 7, 8
),

final as (
    select
        *,
        -- Derived metrics
        case
            when total_orders = 0 then 'never_purchased'
            when datediff(current_date(), last_order_date) <= {{ var('clv_new_days', 90) }} then 'active'
            when datediff(current_date(), last_order_date) <= {{ var('clv_active_days', 365) }} then 'at_risk'
            else 'churned'
        end as customer_segment,

        case
            when lifetime_revenue >= {{ var('clv_platinum_threshold', 10000) }} then 'platinum'
            when lifetime_revenue >= {{ var('clv_gold_threshold', 5000) }} then 'gold'
            when lifetime_revenue >= {{ var('clv_silver_threshold', 1000) }} then 'silver'
            else 'bronze'
        end as value_tier,

        coalesce(
            lifetime_revenue / nullif(
                months_between(current_date(), customer_since), 0
            ), 0
        ) as monthly_revenue_rate,

        current_timestamp() as _dbt_refreshed_at
    from customer_orders
)

select * from final
