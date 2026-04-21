-- materialized='table': Dimension table — small reference dataset,
-- full rebuild ensures all attribute changes are captured.
{{
  config(
    materialized='table',
    file_format='delta' if target.type != 'duckdb' else none,
    tags=['gold', 'products', 'dimension']
  )
}}

/*
  Gold: Product dimension.

  Flattened product attributes for star-schema joins.  Gold filters to
  valid Silver rows only.
*/

WITH products AS (
    SELECT * FROM {{ ref('slv_products') }}
    WHERE is_valid = TRUE
),

final AS (
    SELECT
        product_sk,
        product_id,
        product_name,
        category,
        unit_price,

        -- Price tier for reporting
        CASE
            WHEN unit_price >= {{ var('price_tier_premium', 100) }} THEN 'premium'
            WHEN unit_price >= {{ var('price_tier_standard', 50) }} THEN 'standard'
            WHEN unit_price >= {{ var('price_tier_value', 25) }} THEN 'value'
            ELSE 'economy'
        END AS price_tier,

        now() AS _dbt_refreshed_at
    FROM products
)

SELECT * FROM final
