-- ==========================================================================
-- Gold Report: Fraud Scores
-- Per-transaction fraud probability with ML feature columns.
-- Combines velocity, amount anomaly, merchant risk, and account tenure
-- into a composite fraud probability score.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='transaction_id',
    schema='gold'
) }}

WITH transactions AS (
    SELECT * FROM {{ ref('fct_transactions') }}
    {% if is_incremental() %}
    WHERE transaction_ts > (
        SELECT MAX(transaction_ts) FROM {{ this }}
    )
    {% endif %}
),

scored AS (
    SELECT
        t.transaction_id,
        t.account_id,
        t.amount,
        t.currency,
        t.merchant_name,
        t.merchant_category_code,
        t.channel,
        t.transaction_type,
        t.card_present,
        t.transaction_ts,
        t.country_code,

        -- ML feature columns
        t.velocity_1h,
        t.velocity_24h,
        t.amount_sum_1h,
        t.amount_zscore,
        t.merchant_risk_category,
        t.channel_risk,
        t.account_type,
        t.account_tenure_days,
        t.avg_monthly_spend,
        t.ctr_flag,

        -- ---------------------------------------------------------------
        -- Composite fraud probability (rule-based proxy for ML model)
        -- In production, replace this with an MLflow model invocation.
        -- Weights are illustrative; a trained model would learn these.
        -- ---------------------------------------------------------------
        ROUND(
            LEAST(1.0, GREATEST(0.0,
                -- Velocity component (0-0.30)
                (LEAST(t.velocity_1h, 15) / 15.0) * 0.30

                -- Amount anomaly component (0-0.25)
                + (LEAST(ABS(t.amount_zscore), 5) / 5.0) * 0.25

                -- Merchant risk component (0-0.20)
                + CASE t.merchant_risk_category
                    WHEN 'high'   THEN 0.20
                    WHEN 'medium' THEN 0.08
                    ELSE 0.0
                  END

                -- Channel risk component (0-0.15)
                + CASE t.channel_risk
                    WHEN 'elevated' THEN 0.15
                    ELSE 0.0
                  END

                -- Account tenure component (0-0.10)
                + CASE
                    WHEN t.account_tenure_days < 30  THEN 0.10
                    WHEN t.account_tenure_days < 180 THEN 0.04
                    ELSE 0.0
                  END
            )),
            4
        )                                               AS fraud_probability,

        -- Risk tier derived from probability
        CASE
            WHEN ROUND(
                LEAST(1.0, GREATEST(0.0,
                    (LEAST(t.velocity_1h, 15) / 15.0) * 0.30
                    + (LEAST(ABS(t.amount_zscore), 5) / 5.0) * 0.25
                    + CASE t.merchant_risk_category
                        WHEN 'high'   THEN 0.20
                        WHEN 'medium' THEN 0.08
                        ELSE 0.0
                      END
                    + CASE t.channel_risk
                        WHEN 'elevated' THEN 0.15
                        ELSE 0.0
                      END
                    + CASE
                        WHEN t.account_tenure_days < 30  THEN 0.10
                        WHEN t.account_tenure_days < 180 THEN 0.04
                        ELSE 0.0
                      END
                )),
                4
            ) >= 0.75 THEN 'critical'
            WHEN ROUND(
                LEAST(1.0, GREATEST(0.0,
                    (LEAST(t.velocity_1h, 15) / 15.0) * 0.30
                    + (LEAST(ABS(t.amount_zscore), 5) / 5.0) * 0.25
                    + CASE t.merchant_risk_category
                        WHEN 'high'   THEN 0.20
                        WHEN 'medium' THEN 0.08
                        ELSE 0.0
                      END
                    + CASE t.channel_risk
                        WHEN 'elevated' THEN 0.15
                        ELSE 0.0
                      END
                    + CASE
                        WHEN t.account_tenure_days < 30  THEN 0.10
                        WHEN t.account_tenure_days < 180 THEN 0.04
                        ELSE 0.0
                      END
                )),
                4
            ) >= 0.50 THEN 'high'
            WHEN ROUND(
                LEAST(1.0, GREATEST(0.0,
                    (LEAST(t.velocity_1h, 15) / 15.0) * 0.30
                    + (LEAST(ABS(t.amount_zscore), 5) / 5.0) * 0.25
                    + CASE t.merchant_risk_category
                        WHEN 'high'   THEN 0.20
                        WHEN 'medium' THEN 0.08
                        ELSE 0.0
                      END
                    + CASE t.channel_risk
                        WHEN 'elevated' THEN 0.15
                        ELSE 0.0
                      END
                    + CASE
                        WHEN t.account_tenure_days < 30  THEN 0.10
                        WHEN t.account_tenure_days < 180 THEN 0.04
                        ELSE 0.0
                      END
                )),
                4
            ) >= 0.25 THEN 'medium'
            ELSE 'low'
        END                                             AS risk_tier,

        CURRENT_TIMESTAMP()                             AS scored_at

    FROM transactions t
)

SELECT * FROM scored
