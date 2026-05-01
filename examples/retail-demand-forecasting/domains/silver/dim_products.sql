-- ==========================================================================
-- Dimension Model: Products
-- Provides product attributes and category hierarchy for analytics joins.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_products') }}
),

enriched AS (
    SELECT
        sku,
        product_name,
        category,
        subcategory,
        brand,
        unit_cost,
        unit_msrp,
        pack_size,
        is_active,

        -- Category hierarchy path for drill-down
        CONCAT(category, ' > ', subcategory)        AS category_path,

        -- Target margin percentage
        CASE
            WHEN unit_msrp > 0
            THEN ROUND((unit_msrp - unit_cost) / unit_msrp * 100, 1)
            ELSE NULL
        END                                         AS target_margin_pct,

        ingested_at

    FROM staged
    WHERE is_active = TRUE
)

SELECT * FROM enriched
