{{
  config(
    materialized='incremental',
    unique_key='warehouse_id',
    incremental_strategy='merge',
    file_format='delta',
    tags=['bronze', 'inventory'],
    on_schema_change='fail'
  )
}}

/*
  Bronze: Raw warehouse reference data.
  Small, slowly-changing reference table.
*/

SELECT
    CAST(warehouse_id AS BIGINT) AS warehouse_id,
    warehouse_name,
    region,
    CAST(capacity AS BIGINT) AS capacity,
    _ingested_at,
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id
FROM {{ source('raw_inventory', 'sample_warehouses') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
