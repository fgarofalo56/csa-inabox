-- materialized='table': Full rebuild required — point-in-time snapshot
-- recalculated each run; stock levels change continuously.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'inventory', 'fact']
  )
}}

/*
  Gold: Inventory snapshot fact table.

  Grain: one row per product-warehouse combination.
  Joins valid Silver inventory with warehouse dimension for
  enriched stock position analytics.
*/

WITH inventory AS (
    SELECT * FROM {{ ref('slv_inventory') }}
    WHERE is_valid = TRUE
),

warehouses AS (
    SELECT
        warehouse_sk,
        warehouse_id,
        warehouse_name,
        region
    FROM {{ ref('dim_warehouses') }}
),

final AS (
    SELECT
        i.inventory_sk,
        i.inventory_id,
        i.product_id,
        i.warehouse_id,
        w.warehouse_sk,
        w.warehouse_name,
        w.region AS warehouse_region,

        i.qty_on_hand,
        i.qty_reserved,
        i.qty_on_hand - i.qty_reserved AS qty_available,
        i.reorder_point,

        -- Stock status classification
        CASE
            WHEN i.qty_on_hand = 0 THEN 'OUT_OF_STOCK'
            WHEN i.qty_on_hand <= i.reorder_point * 0.5 THEN 'LOW_STOCK'
            WHEN i.qty_on_hand <= i.reorder_point THEN 'ADEQUATE'
            ELSE 'WELL_STOCKED'
        END AS stock_status,

        -- Reorder flag
        CASE
            WHEN i.qty_on_hand - i.qty_reserved <= i.reorder_point THEN TRUE
            ELSE FALSE
        END AS needs_reorder,

        i.last_restocked_at,
        DATEDIFF(DAY, i.last_restocked_at, current_date()) AS days_since_restock,

        current_date() AS snapshot_date,
        current_timestamp() AS _dbt_refreshed_at

    FROM inventory i
    LEFT JOIN warehouses w ON i.warehouse_id = w.warehouse_id
)

SELECT * FROM final
