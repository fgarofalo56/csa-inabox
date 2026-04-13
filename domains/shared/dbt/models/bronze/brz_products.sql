{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='_surrogate_key',
    incremental_strategy='merge',
    tags=['bronze', 'products']
  )
}}

/*
  Bronze: Raw products ingestion
  Reads from ADLS raw container, adds metadata columns.
  Incremental load based on ingestion timestamp.
*/

SELECT
    {{ dbt_utils.generate_surrogate_key(['product_id']) }} as _surrogate_key,
    product_id,
    product_name,
    category,
    unit_price,
    _ingested_at,
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    input_file_name() AS _source_file

FROM {{ source('raw_data', 'sample_products') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
