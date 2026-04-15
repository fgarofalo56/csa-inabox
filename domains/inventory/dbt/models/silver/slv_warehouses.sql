{{
  config(
    materialized='incremental',
    unique_key='warehouse_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'inventory'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed warehouse reference data with validation flags.
  Small reference table — validation is lightweight.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_warehouses') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY warehouse_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['warehouse_id']) }} AS warehouse_sk,
        CAST(warehouse_id AS BIGINT) AS warehouse_id,
        TRIM(warehouse_name) AS warehouse_name,
        TRIM(region) AS region,
        CAST(capacity AS BIGINT) AS capacity,
        _ingested_at,
        current_timestamp() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN warehouse_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_id,
        CASE WHEN warehouse_name IS NULL OR TRIM(warehouse_name) = '' THEN TRUE ELSE FALSE END AS _is_missing_name,
        CASE WHEN capacity IS NULL OR capacity <= 0 THEN TRUE ELSE FALSE END AS _is_invalid_capacity
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_id OR _is_missing_name OR _is_invalid_capacity
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_id THEN 'warehouse_id null' END,
        CASE WHEN _is_missing_name THEN 'warehouse_name missing' END,
        CASE WHEN _is_invalid_capacity THEN 'capacity invalid' END
    ) AS validation_errors
FROM validated
