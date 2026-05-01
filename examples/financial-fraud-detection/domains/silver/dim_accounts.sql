-- ==========================================================================
-- Dimension Model: Accounts
-- Enriches raw account data with tenure, spending baselines, and status.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

WITH raw_accounts AS (
    SELECT * FROM {{ ref('stg_accounts') }}
),

spending_baseline AS (
    SELECT
        account_id,
        ROUND(AVG(amount), 2)                           AS avg_transaction_amount,
        ROUND(
            SUM(amount) / GREATEST(
                DATEDIFF(MONTH, MIN(transaction_ts), MAX(transaction_ts)), 1
            ),
            2
        )                                               AS avg_monthly_spend,
        COUNT(*)                                        AS lifetime_transaction_count,
        COUNT(DISTINCT merchant_category_code)          AS distinct_merchant_categories
    FROM {{ ref('stg_transactions') }}
    GROUP BY account_id
)

SELECT
    a.account_id,
    a.customer_id,
    a.account_type,
    a.open_date,
    a.status,
    a.credit_limit,
    a.billing_country,

    -- Tenure in days
    DATEDIFF(DAY, a.open_date, CURRENT_DATE())          AS account_tenure_days,

    -- Spending features
    COALESCE(sb.avg_transaction_amount, 0)              AS avg_transaction_amount,
    COALESCE(sb.avg_monthly_spend, 0)                   AS avg_monthly_spend,
    COALESCE(sb.lifetime_transaction_count, 0)          AS lifetime_transaction_count,
    COALESCE(sb.distinct_merchant_categories, 0)        AS distinct_merchant_categories,

    -- Account age risk tier
    CASE
        WHEN DATEDIFF(DAY, a.open_date, CURRENT_DATE()) < 30  THEN 'new'
        WHEN DATEDIFF(DAY, a.open_date, CURRENT_DATE()) < 180 THEN 'recent'
        ELSE 'established'
    END                                                 AS tenure_risk_tier,

    CURRENT_TIMESTAMP()                                 AS updated_at

FROM raw_accounts a
LEFT JOIN spending_baseline sb
    ON a.account_id = sb.account_id
