-- materialized='table': Full rebuild required — reorder status changes as
-- inventory levels fluctuate, no reliable incremental key.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'inventory', 'alerts']
  )
}}

/*
  Gold: Reorder alerts.

  Products where available stock (on_hand - reserved) has fallen
  at or below the reorder point. Cross-domain join to shared
  dim_products for product name and category enrichment.
*/

WITH inventory AS (
    SELECT * FROM {{ ref('fact_inventory_snapshot') }}
    WHERE needs_reorder = TRUE
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
        i.inventory_sk,
        i.inventory_id,
        i.product_id,
        p.product_name,
        p.category AS product_category,
        p.unit_price,

        i.warehouse_id,
        i.warehouse_name,
        i.warehouse_region,

        i.qty_on_hand,
        i.qty_reserved,
        i.qty_available,
        i.reorder_point,
        i.reorder_point - i.qty_available AS qty_deficit,

        i.days_since_restock,

        -- Alert severity based on how far below reorder point
        CASE
            WHEN i.qty_available <= 0 THEN 'CRITICAL'
            WHEN i.qty_available <= i.reorder_point * 0.25 THEN 'URGENT'
            ELSE 'WARNING'
        END AS alert_severity,

        i.stock_status,
        i.snapshot_date,
        current_timestamp() AS _dbt_refreshed_at

    FROM inventory i
    LEFT JOIN products p ON i.product_id = p.product_id
)

SELECT * FROM final
