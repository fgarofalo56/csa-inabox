-- materialized='table': Full rebuild required — this model aggregates across
-- the entire dataset without a reliable incremental key.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'inventory', 'analytics']
  )
}}

/*
  Gold: Inventory turnover analysis.

  Provides inventory health metrics per product. Note: Demand-related
  calculations (daily_demand, days_of_supply, supply_demand_status)
  require a product-level order fact table that doesn't exist yet.
  fact_orders has no product_id, so demand attribution is not possible
  without implementing product-level order line items.

  Current implementation provides valid inventory health metrics while
  explicitly marking demand-related fields as NULL.
*/

WITH inventory AS (
    SELECT
        product_id,
        SUM(qty_on_hand) AS total_on_hand,
        SUM(qty_reserved) AS total_reserved,
        SUM(qty_on_hand - qty_reserved) AS total_available,
        COUNT(*) AS warehouse_count,
        -- Calculate basic reorder metrics from inventory alone
        MAX(reorder_point) AS max_reorder_point,
        MIN(reorder_point) AS min_reorder_point
    FROM {{ ref('fact_inventory_snapshot') }}
    GROUP BY product_id
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

        -- Valid inventory metrics
        i.total_on_hand,
        i.total_reserved,
        i.total_available,
        i.warehouse_count,

        -- Basic inventory health (calculated from reorder points)
        CASE
            WHEN i.total_available <= 0 THEN 'STOCKOUT'
            WHEN i.total_available <= i.max_reorder_point THEN 'LOW_STOCK'
            WHEN i.total_available <= i.min_reorder_point * 2 THEN 'ADEQUATE'
            ELSE 'WELL_STOCKED'
        END AS inventory_status,

        -- Demand-related fields require product-level order data
        -- Setting to NULL until product-order line items are implemented
        NULL AS daily_demand,     -- Requires product_id in fact_orders
        NULL AS days_of_supply,   -- Requires product_id in fact_orders
        NULL AS supply_demand_status,  -- Requires product_id in fact_orders

        now() AS _dbt_refreshed_at

    FROM inventory i
    LEFT JOIN products p ON i.product_id = p.product_id
)

SELECT * FROM final
