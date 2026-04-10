{{
  config(
    materialized='incremental',
    unique_key='inventory_id',
    incremental_strategy='merge',
    file_format='delta',
    tags=['bronze', 'inventory']
  )
}}

/*
  Bronze: Raw inventory records from the warehouse management system.
  Preserves all source columns; adds ingestion metadata.
*/

SELECT
    CAST(inventory_id AS BIGINT) AS inventory_id,
    product_id,
    warehouse_id,
    qty_on_hand,
    qty_reserved,
    reorder_point,
    last_restocked_at,
    _ingested_at,
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_invocation_id
FROM {{ source('raw_inventory', 'sample_inventory') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
