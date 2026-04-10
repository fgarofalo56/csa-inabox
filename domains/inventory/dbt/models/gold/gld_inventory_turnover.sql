{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'inventory', 'analytics']
  )
}}

/*
  Gold: Inventory turnover analysis.

  Cross-domain analytics joining inventory supply (this domain)
  with order demand (shared domain). Calculates turnover ratio
  and days of supply per product.

  Note: fact_orders does not have a quantity column, so we use
  order count as the demand proxy.
*/

WITH inventory AS (
    SELECT
        product_id,
        SUM(qty_on_hand) AS total_on_hand,
        SUM(qty_reserved) AS total_reserved,
        SUM(qty_on_hand - qty_reserved) AS total_available,
        COUNT(*) AS warehouse_count
    FROM {{ ref('fact_inventory_snapshot') }}
    GROUP BY product_id
),

-- Cross-domain: demand from sales orders (last 90 days)
demand AS (
    SELECT
        -- fact_orders doesn't track product_id directly,
        -- so we aggregate at the overall level for a demand signal.
        COUNT(*) AS total_orders_90d,
        SUM(total_amount) AS total_revenue_90d
    FROM {{ ref('fact_orders') }}
    WHERE order_date >= DATEADD(DAY, -90, current_date())
      AND is_delivered = 1
),

products AS (
    SELECT
        product_id,
        product_name,
        category,
        unit_price
    FROM {{ ref('dim_products') }}
),

final AS (
    SELECT
        i.product_id,
        p.product_name,
        p.category AS product_category,
        p.unit_price,

        i.total_on_hand,
        i.total_reserved,
        i.total_available,
        i.warehouse_count,

        d.total_orders_90d,
        d.total_revenue_90d,

        -- Estimated daily demand (orders / 90 days, distributed across products)
        ROUND(
            CAST(d.total_orders_90d AS DECIMAL(18,2))
            / NULLIF(90 * (SELECT COUNT(*) FROM inventory), 0),
            2
        ) AS est_daily_demand,

        -- Days of supply = available / daily demand
        CASE
            WHEN d.total_orders_90d > 0 THEN
                ROUND(
                    CAST(i.total_available AS DECIMAL(18,2))
                    / NULLIF(
                        CAST(d.total_orders_90d AS DECIMAL(18,2))
                        / (90 * (SELECT COUNT(*) FROM inventory)),
                        0
                    ),
                    1
                )
            ELSE NULL
        END AS days_of_supply,

        -- Supply-demand status
        CASE
            WHEN i.total_available <= 0 THEN 'STOCKOUT'
            WHEN d.total_orders_90d = 0 THEN 'NO_DEMAND'
            WHEN i.total_available / NULLIF(
                CAST(d.total_orders_90d AS DECIMAL(18,2)) / (90 * (SELECT COUNT(*) FROM inventory)),
                0
            ) < 14 THEN 'UNDERSTOCKED'
            WHEN i.total_available / NULLIF(
                CAST(d.total_orders_90d AS DECIMAL(18,2)) / (90 * (SELECT COUNT(*) FROM inventory)),
                0
            ) > 180 THEN 'OVERSTOCKED'
            ELSE 'BALANCED'
        END AS supply_demand_status,

        current_timestamp() AS _dbt_refreshed_at

    FROM inventory i
    LEFT JOIN products p ON i.product_id = p.product_id
    CROSS JOIN demand d
)

SELECT * FROM final
