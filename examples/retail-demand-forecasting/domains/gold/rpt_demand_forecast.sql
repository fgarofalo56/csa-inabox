-- ==========================================================================
-- Gold Report: 14-Day Demand Forecast
-- Produces a rolling 14-day forward demand projection per store/SKU
-- using trailing sales velocity, trend, and day-of-week seasonality.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH daily_sales AS (
    SELECT * FROM {{ ref('fct_daily_sales') }}
    WHERE sale_date >= DATEADD(DAY, -90, CURRENT_DATE())
),

products AS (
    SELECT * FROM {{ ref('dim_products') }}
),

stores AS (
    SELECT * FROM {{ ref('dim_stores') }}
),

-- Trailing velocity: 7-day, 14-day, and 28-day moving averages
velocity AS (
    SELECT
        store_id,
        sku,
        sale_date,
        units_sold,
        AVG(units_sold) OVER (
            PARTITION BY store_id, sku
            ORDER BY sale_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        )                                           AS avg_7d,
        AVG(units_sold) OVER (
            PARTITION BY store_id, sku
            ORDER BY sale_date
            ROWS BETWEEN 13 PRECEDING AND CURRENT ROW
        )                                           AS avg_14d,
        AVG(units_sold) OVER (
            PARTITION BY store_id, sku
            ORDER BY sale_date
            ROWS BETWEEN 27 PRECEDING AND CURRENT ROW
        )                                           AS avg_28d
    FROM daily_sales
),

-- Day-of-week seasonality index (ratio of DOW avg to overall avg)
dow_index AS (
    SELECT
        store_id,
        sku,
        DAYOFWEEK(sale_date)                        AS dow,
        AVG(units_sold)                             AS dow_avg,
        AVG(AVG(units_sold)) OVER (
            PARTITION BY store_id, sku
        )                                           AS overall_avg,
        CASE
            WHEN AVG(AVG(units_sold)) OVER (PARTITION BY store_id, sku) > 0
            THEN ROUND(
                AVG(units_sold) /
                AVG(AVG(units_sold)) OVER (PARTITION BY store_id, sku),
                3
            )
            ELSE 1.0
        END                                         AS seasonal_index
    FROM daily_sales
    GROUP BY store_id, sku, DAYOFWEEK(sale_date)
),

-- Latest velocity per store/SKU
latest_velocity AS (
    SELECT *
    FROM velocity
    WHERE sale_date = (
        SELECT MAX(sale_date) FROM velocity v2
        WHERE v2.store_id = velocity.store_id
          AND v2.sku      = velocity.sku
    )
),

-- Generate 14 future dates
future_dates AS (
    SELECT EXPLODE(SEQUENCE(1, 14)) AS day_offset
),

forecast AS (
    SELECT
        lv.store_id,
        s.store_name,
        s.region,
        lv.sku,
        p.product_name,
        p.category,
        DATEADD(DAY, fd.day_offset, CURRENT_DATE()) AS forecast_date,
        fd.day_offset,

        -- Blended base forecast: weighted average of trailing windows
        ROUND(
            0.5 * lv.avg_7d + 0.3 * lv.avg_14d + 0.2 * lv.avg_28d,
            2
        )                                           AS base_forecast,

        -- Seasonally adjusted forecast
        ROUND(
            (0.5 * lv.avg_7d + 0.3 * lv.avg_14d + 0.2 * lv.avg_28d)
            * COALESCE(di.seasonal_index, 1.0),
            2
        )                                           AS adj_forecast,

        COALESCE(di.seasonal_index, 1.0)            AS dow_seasonal_index,

        -- Trend direction
        CASE
            WHEN lv.avg_7d > lv.avg_28d * 1.1 THEN 'Accelerating'
            WHEN lv.avg_7d < lv.avg_28d * 0.9 THEN 'Decelerating'
            ELSE 'Stable'
        END                                         AS trend_direction,

        CURRENT_TIMESTAMP()                         AS generated_at

    FROM latest_velocity lv
    CROSS JOIN future_dates fd
    LEFT JOIN dow_index di
        ON  lv.store_id = di.store_id
        AND lv.sku      = di.sku
        AND DAYOFWEEK(DATEADD(DAY, fd.day_offset, CURRENT_DATE())) = di.dow
    LEFT JOIN products p ON lv.sku = p.sku
    LEFT JOIN stores s   ON lv.store_id = s.store_id
)

SELECT * FROM forecast
ORDER BY store_id, sku, forecast_date
