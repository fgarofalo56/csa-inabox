-- ==========================================================================
-- Fact Model: Daily Sales Aggregation
-- Aggregates POS transactions to one row per store / SKU / day.
-- Joined with latest inventory snapshot for days-of-supply calculation.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='daily_sales_key',
    schema='silver'
) }}

WITH transactions AS (
    SELECT * FROM {{ ref('stg_pos_transactions') }}
),

inventory AS (
    SELECT * FROM {{ ref('stg_inventory') }}
),

daily_agg AS (
    SELECT
        CONCAT(
            t.store_id, '|',
            t.sku, '|',
            CAST(CAST(t.transaction_timestamp AS DATE) AS STRING)
        )                                           AS daily_sales_key,
        t.store_id,
        t.sku,
        CAST(t.transaction_timestamp AS DATE)       AS sale_date,
        COUNT(DISTINCT t.transaction_id)            AS transaction_count,
        SUM(t.quantity)                             AS units_sold,
        SUM(t.line_total)                          AS gross_revenue,
        SUM(t.discount_amount)                     AS total_discount,
        SUM(t.line_total)
            - SUM(t.discount_amount)               AS net_revenue,
        AVG(t.unit_price)                          AS avg_selling_price
    FROM transactions t
    GROUP BY
        t.store_id,
        t.sku,
        CAST(t.transaction_timestamp AS DATE)
),

with_inventory AS (
    SELECT
        d.*,
        i.on_hand_qty,
        i.on_order_qty,

        -- Days of supply: on-hand divided by trailing 7-day avg daily sales
        CASE
            WHEN d.units_sold > 0
            THEN ROUND(CAST(i.on_hand_qty AS DOUBLE) / d.units_sold, 1)
            ELSE NULL
        END                                         AS est_days_of_supply,

        CURRENT_TIMESTAMP()                         AS processed_at

    FROM daily_agg d
    LEFT JOIN inventory i
        ON  d.store_id = i.store_id
        AND d.sku      = i.sku
        AND d.sale_date = i.snapshot_date
)

SELECT * FROM with_inventory

{% if is_incremental() %}
WHERE sale_date > (
    SELECT MAX(sale_date) FROM {{ this }}
)
{% endif %}
