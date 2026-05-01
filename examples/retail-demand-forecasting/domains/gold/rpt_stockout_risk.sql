-- ==========================================================================
-- Gold Report: Stockout Risk Scoring
-- Scores each store/SKU by probability of reaching zero on-hand
-- before the next expected replenishment, based on current inventory
-- levels and recent sales velocity.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH daily_sales AS (
    SELECT * FROM {{ ref('fct_daily_sales') }}
),

products AS (
    SELECT * FROM {{ ref('dim_products') }}
),

stores AS (
    SELECT * FROM {{ ref('dim_stores') }}
),

-- Most recent inventory position per store/SKU
latest_inventory AS (
    SELECT
        store_id,
        sku,
        on_hand_qty,
        on_order_qty,
        sale_date                                   AS snapshot_date
    FROM daily_sales
    WHERE sale_date = (
        SELECT MAX(sale_date) FROM daily_sales d2
        WHERE d2.store_id = daily_sales.store_id
          AND d2.sku      = daily_sales.sku
    )
),

-- Trailing 14-day average daily demand
avg_demand AS (
    SELECT
        store_id,
        sku,
        AVG(units_sold)                             AS avg_daily_demand,
        STDDEV(units_sold)                          AS stddev_daily_demand
    FROM daily_sales
    WHERE sale_date >= DATEADD(DAY, -14, CURRENT_DATE())
    GROUP BY store_id, sku
),

scored AS (
    SELECT
        li.store_id,
        s.store_name,
        s.region,
        li.sku,
        p.product_name,
        p.category,
        li.on_hand_qty,
        li.on_order_qty,
        ROUND(ad.avg_daily_demand, 2)               AS avg_daily_demand,

        -- Estimated days of supply
        CASE
            WHEN ad.avg_daily_demand > 0
            THEN ROUND(
                CAST(li.on_hand_qty AS DOUBLE) / ad.avg_daily_demand,
                1
            )
            ELSE 999
        END                                         AS days_of_supply,

        -- Assume 7-day replenishment lead time; score risk accordingly
        CASE
            WHEN ad.avg_daily_demand <= 0 THEN 0.0
            WHEN li.on_hand_qty <= 0      THEN 1.0
            WHEN (CAST(li.on_hand_qty AS DOUBLE) / ad.avg_daily_demand) < 3
                THEN 0.95
            WHEN (CAST(li.on_hand_qty AS DOUBLE) / ad.avg_daily_demand) < 5
                THEN 0.75
            WHEN (CAST(li.on_hand_qty AS DOUBLE) / ad.avg_daily_demand) < 7
                THEN 0.50
            WHEN (CAST(li.on_hand_qty AS DOUBLE) / ad.avg_daily_demand) < 10
                THEN 0.25
            ELSE 0.05
        END                                         AS stockout_probability,

        -- Risk tier
        CASE
            WHEN li.on_hand_qty <= 0 THEN 'Out of Stock'
            WHEN (CAST(li.on_hand_qty AS DOUBLE) /
                  NULLIF(ad.avg_daily_demand, 0)) < 3
                THEN 'Critical'
            WHEN (CAST(li.on_hand_qty AS DOUBLE) /
                  NULLIF(ad.avg_daily_demand, 0)) < 7
                THEN 'High'
            WHEN (CAST(li.on_hand_qty AS DOUBLE) /
                  NULLIF(ad.avg_daily_demand, 0)) < 14
                THEN 'Medium'
            ELSE 'Low'
        END                                         AS risk_tier,

        -- Suggested reorder quantity: cover 14 days of demand minus pipeline
        GREATEST(
            ROUND(
                ad.avg_daily_demand * 14
                - li.on_hand_qty
                - COALESCE(li.on_order_qty, 0),
                0
            ),
            0
        )                                           AS suggested_reorder_qty,

        li.snapshot_date,
        CURRENT_TIMESTAMP()                         AS scored_at

    FROM latest_inventory li
    INNER JOIN avg_demand ad
        ON  li.store_id = ad.store_id
        AND li.sku      = ad.sku
    LEFT JOIN products p ON li.sku = p.sku
    LEFT JOIN stores s   ON li.store_id = s.store_id
)

SELECT * FROM scored
ORDER BY stockout_probability DESC, days_of_supply ASC
