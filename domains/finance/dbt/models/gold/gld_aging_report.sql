-- materialized='table': Full rebuild required — aging buckets are recalculated
-- daily based on current_date() making incremental unreliable.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'finance', 'aging']
  )
}}

/*
  Gold: Accounts Receivable Aging Report.

  Classifies outstanding invoices into aging buckets (current, 30, 60,
  90, 120+ days) for finance dashboards.  Joins invoices with payments
  to compute outstanding balances.
*/

WITH invoices AS (
    SELECT * FROM {{ ref('slv_invoices') }}
    WHERE is_valid = TRUE
),

payments AS (
    SELECT
        invoice_id,
        SUM(amount) AS total_paid
    FROM {{ ref('slv_payments') }}
    WHERE is_valid = TRUE
    GROUP BY invoice_id
),

invoice_balances AS (
    SELECT
        i.invoice_id,
        i.customer_id,
        i.invoice_date,
        i.due_date,
        i.total_amount + i.tax_amount AS invoice_total,
        COALESCE(p.total_paid, 0) AS total_paid,
        (i.total_amount + i.tax_amount) - COALESCE(p.total_paid, 0) AS outstanding_balance,
        i.status,
        DATEDIFF(current_date(), i.due_date) AS days_past_due
    FROM invoices i
    LEFT JOIN payments p ON i.invoice_id = p.invoice_id
),

final AS (
    SELECT
        *,
        CASE
            WHEN outstanding_balance <= 0 THEN 'PAID'
            WHEN days_past_due <= 0 THEN 'CURRENT'
            WHEN days_past_due <= 30 THEN '1-30'
            WHEN days_past_due <= 60 THEN '31-60'
            WHEN days_past_due <= 90 THEN '61-90'
            ELSE '90+'
        END AS aging_bucket,

        CASE
            WHEN outstanding_balance <= 0 THEN 0
            WHEN days_past_due <= 0 THEN 0
            WHEN days_past_due <= 30 THEN {{ var('loss_rate_0_30', 0.01) }}
            WHEN days_past_due <= 60 THEN {{ var('loss_rate_31_60', 0.05) }}
            WHEN days_past_due <= 90 THEN {{ var('loss_rate_61_90', 0.10) }}
            ELSE {{ var('loss_rate_over_90', 0.25) }}
        END AS estimated_loss_rate,

        current_timestamp() AS _dbt_refreshed_at
    FROM invoice_balances
    WHERE outstanding_balance > 0  -- Only outstanding invoices
)

SELECT * FROM final
