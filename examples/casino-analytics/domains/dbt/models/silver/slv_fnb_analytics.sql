{{ config(
    materialized='incremental',
    unique_key='fnb_analytics_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'fnb', 'analytics', 'hospitality']
) }}

/*
    Silver Layer — F&B Analytics

    Transforms raw F&B POS transactions with:
    - Comp ratio analysis (comp value vs total spend)
    - Menu item popularity and average check metrics by venue
    - Venue utilization and peak period identification
    - Player-level dining behavior enrichment

    All data is ENTIRELY SYNTHETIC.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_fnb_transactions') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            transaction_id,
            COALESCE(player_id, 'UNKNOWN'),
            CAST(transaction_date AS STRING)
        )) AS fnb_analytics_sk,

        -- Transaction identifiers
        transaction_id,
        player_id,
        CASE WHEN player_id IS NOT NULL AND TRIM(player_id) != '' THEN TRUE ELSE FALSE END AS is_rated_guest,

        -- Venue classification
        venue,
        CASE
            WHEN venue IN ('Fine Dining', 'Steakhouse') THEN 'UPSCALE'
            WHEN venue IN ('Buffet', 'Noodle Bar', 'Cafe') THEN 'CASUAL'
            WHEN venue IN ('Sports Bar', 'Pool Bar') THEN 'BAR'
            WHEN venue IN ('Food Court') THEN 'QUICK_SERVICE'
            ELSE 'OTHER'
        END AS venue_category,

        -- Timing
        transaction_date,
        meal_period,
        DAYOFWEEK(transaction_date) AS day_of_week,
        CASE
            WHEN DAYOFWEEK(transaction_date) IN (1, 7) THEN 'WEEKEND'
            ELSE 'WEEKDAY'
        END AS day_type,

        -- Transaction financials
        items_count,
        ROUND(subtotal, 2) AS subtotal,
        ROUND(tax, 2) AS tax,
        ROUND(total, 2) AS total,
        ROUND(tip_amount, 2) AS tip_amount,

        -- Average per item
        CASE
            WHEN items_count > 0
            THEN ROUND(subtotal / items_count, 2)
            ELSE subtotal
        END AS avg_item_price,

        -- Comp analysis
        UPPER(payment_type) AS payment_type,
        CASE WHEN UPPER(payment_type) = 'COMP' THEN TRUE ELSE FALSE END AS is_comp,
        ROUND(COALESCE(comp_value, 0), 2) AS comp_value,

        -- Comp ratio (how much of the total was comped)
        CASE
            WHEN total > 0 AND UPPER(payment_type) = 'COMP'
            THEN 100.0
            WHEN total > 0 AND comp_value > 0
            THEN ROUND(comp_value / total * 100, 2)
            ELSE 0.0
        END AS comp_ratio_pct,

        -- Tip analysis
        CASE
            WHEN subtotal > 0 AND tip_amount > 0
            THEN ROUND(tip_amount / subtotal * 100, 2)
            ELSE 0.0
        END AS tip_pct,

        -- Guest satisfaction
        party_size,
        satisfaction_score,
        CASE
            WHEN satisfaction_score >= 4 THEN 'SATISFIED'
            WHEN satisfaction_score = 3 THEN 'NEUTRAL'
            WHEN satisfaction_score IS NOT NULL THEN 'DISSATISFIED'
            ELSE 'NOT_RATED'
        END AS satisfaction_category,

        -- Check size category
        CASE
            WHEN total < 15 THEN 'LOW'
            WHEN total < 40 THEN 'MEDIUM'
            WHEN total < 80 THEN 'HIGH'
            ELSE 'PREMIUM'
        END AS check_size_category,

        -- Data quality
        CASE
            WHEN transaction_id IS NOT NULL
                 AND transaction_date IS NOT NULL
                 AND venue IS NOT NULL
                 AND total >= 0
            THEN TRUE
            ELSE FALSE
        END AS is_valid,

        -- Metadata
        source_system,
        ingestion_timestamp,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
WHERE is_valid = TRUE
