{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='payment_id',
    incremental_strategy='merge',
    tags=['bronze', 'finance', 'payments'],
    on_schema_change='fail'
  )
}}

SELECT
    payment_id,
    invoice_id,
    payment_date,
    amount,
    payment_method,
    reference_number,
    _ingested_at,
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    input_file_name() AS _source_file

FROM {{ source('raw_finance', 'sample_payments') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
