-- ==========================================================================
-- Gold Report: Suspicious Activity Reports (SAR-ready)
-- Aggregates account-level suspicious patterns over a 30-day window.
-- Output aligns with FinCEN SAR e-filing field requirements.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH scored_transactions AS (
    SELECT * FROM {{ ref('rpt_fraud_scores') }}
    WHERE transaction_ts >= DATEADD(DAY, -30, CURRENT_DATE())
),

accounts AS (
    SELECT * FROM {{ ref('dim_accounts') }}
),

-- Aggregate suspicious activity per account
account_activity AS (
    SELECT
        st.account_id,

        -- Transaction volume
        COUNT(*)                                        AS total_transactions,
        SUM(CASE WHEN st.fraud_probability >= 0.50
            THEN 1 ELSE 0 END)                          AS suspicious_transaction_count,
        SUM(CASE WHEN st.fraud_probability >= 0.75
            THEN 1 ELSE 0 END)                          AS critical_transaction_count,

        -- Amounts
        SUM(st.amount)                                  AS total_amount,
        SUM(CASE WHEN st.fraud_probability >= 0.50
            THEN st.amount ELSE 0 END)                  AS suspicious_amount,
        MAX(st.amount)                                  AS max_single_transaction,
        ROUND(AVG(st.fraud_probability), 4)             AS avg_fraud_probability,
        MAX(st.fraud_probability)                       AS max_fraud_probability,

        -- Activity characterization
        COUNT(DISTINCT st.merchant_category_code)       AS distinct_mcc_codes,
        COUNT(DISTINCT st.channel)                      AS distinct_channels,
        COUNT(DISTINCT st.country_code)                 AS distinct_countries,
        SUM(CASE WHEN st.ctr_flag = TRUE
            THEN 1 ELSE 0 END)                          AS ctr_flagged_count,

        -- Structuring indicator: multiple transactions between $8k-$10k
        SUM(CASE WHEN st.amount BETWEEN 8000 AND 9999
            THEN 1 ELSE 0 END)                          AS near_ctr_threshold_count,

        -- Time range
        MIN(st.transaction_ts)                          AS activity_start,
        MAX(st.transaction_ts)                          AS activity_end

    FROM scored_transactions st
    GROUP BY st.account_id
),

-- Filter to accounts meeting SAR thresholds
sar_candidates AS (
    SELECT
        aa.*,
        a.customer_id,
        a.account_type,
        a.open_date,
        a.billing_country,
        a.account_tenure_days,

        -- SAR filing reason
        CASE
            WHEN aa.critical_transaction_count >= 3
                THEN 'Multiple critical-risk transactions'
            WHEN aa.near_ctr_threshold_count >= 3
                THEN 'Potential structuring activity'
            WHEN aa.suspicious_amount >= 25000
                THEN 'Cumulative suspicious amount exceeds threshold'
            WHEN aa.distinct_countries >= 4
                THEN 'Unusual cross-border transaction pattern'
            WHEN aa.max_fraud_probability >= 0.90
                THEN 'Extremely high fraud probability detected'
            ELSE 'Elevated risk pattern'
        END                                             AS filing_reason,

        -- Priority for analyst review
        ROUND(
            aa.avg_fraud_probability
            * LOG2(aa.suspicious_transaction_count + 1)
            * (1 + aa.near_ctr_threshold_count * 0.5),
            3
        )                                               AS review_priority,

        CURRENT_DATE()                                  AS report_date,
        CURRENT_TIMESTAMP()                             AS generated_at

    FROM account_activity aa
    INNER JOIN accounts a ON aa.account_id = a.account_id
    WHERE aa.suspicious_transaction_count >= 2
       OR aa.near_ctr_threshold_count >= 3
       OR aa.suspicious_amount >= 25000
       OR aa.max_fraud_probability >= 0.90
)

SELECT * FROM sar_candidates
ORDER BY review_priority DESC
