{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='_surrogate_key',
    incremental_strategy='merge',
    tags=['bronze', 'orders']
  )
}}

/*
  Bronze: Raw orders ingestion
  Reads from ADLS raw container, adds metadata columns.
  Incremental load based on ingestion timestamp.
*/

SELECT
    {{ dbt_utils.generate_surrogate_key(['order_id']) }} as _surrogate_key,
    order_id,
    customer_id,
    order_date,
    total_amount,
    status,
    _ingested_at,
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    input_file_name() AS _source_file

FROM {{ source('raw_data', 'sample_orders') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
