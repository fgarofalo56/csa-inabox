-- ==========================================================================
-- Fact Model: Enriched Transactions
-- Joins staged transactions with account and merchant dimensions.
-- Computes velocity features and amount z-scores for ML scoring.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='transaction_id',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_transactions') }}
),

accounts AS (
    SELECT * FROM {{ ref('dim_accounts') }}
),

merchants AS (
    SELECT * FROM {{ ref('dim_merchants') }}
),

-- Velocity features: rolling counts and amounts per account
velocity AS (
    SELECT
        s.transaction_id,
        s.account_id,
        s.transaction_ts,

        -- 1-hour velocity: transactions in the prior 60 minutes
        COUNT(*) OVER (
            PARTITION BY s.account_id
            ORDER BY CAST(s.transaction_ts AS LONG)
            RANGE BETWEEN 3600 PRECEDING AND CURRENT ROW
        )                                               AS velocity_1h,

        -- 24-hour velocity
        COUNT(*) OVER (
            PARTITION BY s.account_id
            ORDER BY CAST(s.transaction_ts AS LONG)
            RANGE BETWEEN 86400 PRECEDING AND CURRENT ROW
        )                                               AS velocity_24h,

        -- 1-hour cumulative amount
        SUM(s.amount) OVER (
            PARTITION BY s.account_id
            ORDER BY CAST(s.transaction_ts AS LONG)
            RANGE BETWEEN 3600 PRECEDING AND CURRENT ROW
        )                                               AS amount_sum_1h

    FROM staged s
),

-- Amount z-score: how far this transaction deviates from the account mean
account_stats AS (
    SELECT
        account_id,
        AVG(amount)                                     AS avg_amount,
        STDDEV(amount)                                  AS stddev_amount
    FROM staged
    GROUP BY account_id
),

enriched AS (
    SELECT
        s.transaction_id,
        s.account_id,
        s.amount,
        s.currency,
        s.merchant_name,
        s.merchant_category_code,
        s.channel,
        s.transaction_type,
        s.card_present,
        s.transaction_ts,
        s.country_code,
        s.response_code,
        s.ingested_at,

        -- Account features
        a.account_type,
        a.account_tenure_days,
        a.avg_monthly_spend,

        -- Merchant features
        m.risk_category                                 AS merchant_risk_category,
        m.mcc_description,

        -- Velocity features
        v.velocity_1h,
        v.velocity_24h,
        v.amount_sum_1h,

        -- Amount z-score
        ROUND(
            CASE
                WHEN COALESCE(ast.stddev_amount, 0) = 0 THEN 0
                ELSE (s.amount - ast.avg_amount) / ast.stddev_amount
            END,
            3
        )                                               AS amount_zscore,

        -- CTR threshold flag (>= $10,000 single transaction)
        CASE
            WHEN s.amount >= 10000 THEN TRUE
            ELSE FALSE
        END                                             AS ctr_flag,

        -- Channel risk indicator
        CASE
            WHEN s.card_present = FALSE AND s.channel = 'online' THEN 'elevated'
            WHEN s.channel = 'atm' AND s.country_code != a.billing_country THEN 'elevated'
            ELSE 'normal'
        END                                             AS channel_risk,

        CURRENT_TIMESTAMP()                             AS processed_at

    FROM staged s
    LEFT JOIN velocity v
        ON s.transaction_id = v.transaction_id
    LEFT JOIN account_stats ast
        ON s.account_id = ast.account_id
    LEFT JOIN accounts a
        ON s.account_id = a.account_id
    LEFT JOIN merchants m
        ON s.merchant_category_code = m.merchant_category_code
)

SELECT * FROM enriched

{% if is_incremental() %}
WHERE transaction_ts > (
    SELECT MAX(transaction_ts) FROM {{ this }}
)
{% endif %}
