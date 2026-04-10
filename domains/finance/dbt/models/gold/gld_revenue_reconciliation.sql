{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'finance', 'cross-domain', 'reconciliation']
  )
}}

/*
  Gold: Revenue Reconciliation — cross-domain join.

  This model demonstrates the Data Mesh pattern: the finance domain
  consumes a Gold-layer data product from the shared/sales domain
  (fact_orders) and joins it with its own invoice data.  Both domains
  maintain independent ownership and SLAs, but share data via
  well-defined Gold contracts.

  Purpose: reconcile order revenue (from sales) with invoiced revenue
  (from finance) to identify discrepancies.
*/

WITH orders AS (
    -- Cross-domain reference: sales domain's Gold fact table.
    -- In a production Data Mesh this would be a data product contract
    -- reference, not a direct ref.  For the reference implementation
    -- we use dbt ref() to keep compilation simple.
    SELECT
        order_id,
        customer_id,
        order_date,
        total_amount AS order_amount,
        order_status
    FROM {{ ref('fact_orders') }}
),

invoices AS (
    SELECT
        invoice_id,
        order_id,
        customer_id,
        invoice_date,
        total_amount AS invoice_amount,
        tax_amount,
        status AS invoice_status
    FROM {{ ref('slv_invoices') }}
    WHERE is_valid = TRUE
),

reconciled AS (
    SELECT
        COALESCE(o.order_id, i.order_id) AS order_id,
        o.customer_id,
        o.order_date,
        o.order_amount,
        o.order_status,
        i.invoice_id,
        i.invoice_date,
        i.invoice_amount,
        i.tax_amount,
        i.invoice_status,

        -- Reconciliation flags
        CASE
            WHEN o.order_id IS NULL THEN 'INVOICE_ONLY'
            WHEN i.invoice_id IS NULL THEN 'ORDER_ONLY'
            WHEN ABS(o.order_amount - i.invoice_amount) < 0.01 THEN 'MATCHED'
            ELSE 'AMOUNT_MISMATCH'
        END AS reconciliation_status,

        COALESCE(o.order_amount, 0) - COALESCE(i.invoice_amount, 0) AS amount_difference,

        current_timestamp() AS _dbt_refreshed_at
    FROM orders o
    FULL OUTER JOIN invoices i ON o.order_id = i.order_id
)

SELECT * FROM reconciled
