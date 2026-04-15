{{
  config(
    materialized='table',
    -- materialized='table': Dimension table — small reference dataset,
    -- full rebuild ensures all attribute changes are captured.
    file_format='delta',
    tags=['gold', 'inventory', 'dimension']
  )
}}

/*
  Gold: Warehouse dimension.
  Simple reference dimension built from valid Silver records.
*/

SELECT
    warehouse_sk,
    warehouse_id,
    warehouse_name,
    region,
    capacity,
    current_timestamp() AS _dbt_refreshed_at
FROM {{ ref('slv_warehouses') }}
WHERE is_valid = TRUE
