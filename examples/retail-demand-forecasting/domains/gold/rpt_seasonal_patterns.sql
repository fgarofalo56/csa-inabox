-- ==========================================================================
-- Gold Report: Seasonal Pattern Analysis
-- Decomposes weekly sales into trend, seasonal index, and residual
-- components. Provides year-over-year comparison by category and region.
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

-- Aggregate to weekly grain by category and region
weekly_sales AS (
    SELECT
        s.region,
        p.category,
        YEAR(d.sale_date)                           AS sale_year,
        WEEKOFYEAR(d.sale_date)                     AS sale_week,
        MIN(d.sale_date)                            AS week_start,
        SUM(d.units_sold)                           AS weekly_units,
        SUM(d.net_revenue)                          AS weekly_revenue,
        COUNT(DISTINCT d.sku)                       AS active_skus
    FROM daily_sales d
    INNER JOIN products p ON d.sku = p.sku
    INNER JOIN stores s   ON d.store_id = s.store_id
    GROUP BY s.region, p.category, YEAR(d.sale_date), WEEKOFYEAR(d.sale_date)
),

-- Compute trailing 13-week moving average as trend component
with_trend AS (
    SELECT
        *,
        AVG(weekly_units) OVER (
            PARTITION BY region, category
            ORDER BY sale_year, sale_week
            ROWS BETWEEN 12 PRECEDING AND CURRENT ROW
        )                                           AS trend_13w,
        AVG(weekly_revenue) OVER (
            PARTITION BY region, category
            ORDER BY sale_year, sale_week
            ROWS BETWEEN 12 PRECEDING AND CURRENT ROW
        )                                           AS trend_revenue_13w
    FROM weekly_sales
),

-- Seasonal index: ratio of actual to trend
with_seasonal AS (
    SELECT
        *,
        CASE
            WHEN trend_13w > 0
            THEN ROUND(weekly_units / trend_13w, 3)
            ELSE 1.0
        END                                         AS seasonal_index,

        -- Residual: actual minus (trend * seasonal)
        ROUND(
            weekly_units - trend_13w,
            2
        )                                           AS residual
    FROM with_trend
),

-- Year-over-year comparison
yoy AS (
    SELECT
        curr.*,
        prev.weekly_units                           AS prev_year_units,
        prev.weekly_revenue                         AS prev_year_revenue,

        CASE
            WHEN prev.weekly_units > 0
            THEN ROUND(
                (curr.weekly_units - prev.weekly_units)
                / CAST(prev.weekly_units AS DOUBLE) * 100,
                1
            )
            ELSE NULL
        END                                         AS yoy_units_pct,

        CASE
            WHEN prev.weekly_revenue > 0
            THEN ROUND(
                (curr.weekly_revenue - prev.weekly_revenue)
                / CAST(prev.weekly_revenue AS DOUBLE) * 100,
                1
            )
            ELSE NULL
        END                                         AS yoy_revenue_pct,

        CURRENT_TIMESTAMP()                         AS generated_at

    FROM with_seasonal curr
    LEFT JOIN with_seasonal prev
        ON  curr.region   = prev.region
        AND curr.category = prev.category
        AND curr.sale_week = prev.sale_week
        AND curr.sale_year = prev.sale_year + 1
)

SELECT * FROM yoy
ORDER BY region, category, sale_year DESC, sale_week DESC
