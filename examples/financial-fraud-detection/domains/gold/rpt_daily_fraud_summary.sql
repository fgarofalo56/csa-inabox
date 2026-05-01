-- ==========================================================================
-- Gold Report: Daily Fraud Summary
-- Operational fraud metrics aggregated by day for dashboard consumption.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH scored AS (
    SELECT * FROM {{ ref('rpt_fraud_scores') }}
    WHERE transaction_ts >= DATEADD(DAY, -90, CURRENT_DATE())
),

daily_metrics AS (
    SELECT
        CAST(transaction_ts AS DATE)                    AS report_date,

        -- Volume metrics
        COUNT(*)                                        AS total_transactions,
        SUM(CASE WHEN risk_tier = 'critical' THEN 1 ELSE 0 END) AS critical_count,
        SUM(CASE WHEN risk_tier = 'high'     THEN 1 ELSE 0 END) AS high_count,
        SUM(CASE WHEN risk_tier = 'medium'   THEN 1 ELSE 0 END) AS medium_count,
        SUM(CASE WHEN risk_tier = 'low'      THEN 1 ELSE 0 END) AS low_count,

        -- Rate metrics
        ROUND(
            SUM(CASE WHEN risk_tier IN ('critical', 'high') THEN 1 ELSE 0 END)
            * 100.0 / NULLIF(COUNT(*), 0),
            3
        )                                               AS high_risk_rate_pct,

        -- Amount metrics
        SUM(amount)                                     AS total_amount,
        SUM(CASE WHEN risk_tier IN ('critical', 'high')
            THEN amount ELSE 0 END)                     AS flagged_amount,
        ROUND(AVG(amount), 2)                           AS avg_transaction_amount,

        -- Score distribution
        ROUND(AVG(fraud_probability), 4)                AS avg_fraud_score,
        MAX(fraud_probability)                          AS max_fraud_score,
        PERCENTILE_CONT(0.95) WITHIN GROUP
            (ORDER BY fraud_probability)                AS p95_fraud_score,

        -- Channel breakdown
        SUM(CASE WHEN channel = 'pos'    THEN 1 ELSE 0 END) AS pos_count,
        SUM(CASE WHEN channel = 'online' THEN 1 ELSE 0 END) AS online_count,
        SUM(CASE WHEN channel = 'atm'    THEN 1 ELSE 0 END) AS atm_count,
        SUM(CASE WHEN channel = 'mobile' THEN 1 ELSE 0 END) AS mobile_count,
        SUM(CASE WHEN channel = 'wire'   THEN 1 ELSE 0 END) AS wire_count,

        -- CTR flags
        SUM(CASE WHEN ctr_flag = TRUE THEN 1 ELSE 0 END) AS ctr_flagged_count,

        -- Distinct entities
        COUNT(DISTINCT account_id)                      AS distinct_accounts,
        COUNT(DISTINCT merchant_category_code)          AS distinct_merchants

    FROM scored
    GROUP BY CAST(transaction_ts AS DATE)
)

SELECT
    *,
    CURRENT_TIMESTAMP()                                 AS generated_at
FROM daily_metrics
ORDER BY report_date DESC
