{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='invoice_id',
    incremental_strategy='merge',
    tags=['bronze', 'finance', 'invoices']
  )
}}

SELECT
    invoice_id,
    order_id,
    customer_id,
    invoice_date,
    due_date,
    total_amount,
    tax_amount,
    currency,
    status,
    _ingested_at,
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    input_file_name() AS _source_file

FROM {{ source('raw_finance', 'sample_invoices') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
