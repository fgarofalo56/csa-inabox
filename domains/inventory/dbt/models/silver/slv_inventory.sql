{{
  config(
    materialized='incremental',
    unique_key='inventory_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'inventory'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed inventory with validation flags.
  Follows the flag-don't-drop pattern — every row flows through,
  invalid rows are flagged with is_valid = FALSE and human-readable
  validation_errors. Gold filters on is_valid = TRUE.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_inventory') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY inventory_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['inventory_id']) }} AS inventory_sk,
        CAST(inventory_id AS BIGINT) AS inventory_id,
        CAST(product_id AS BIGINT) AS product_id,
        CAST(warehouse_id AS BIGINT) AS warehouse_id,
        CAST(qty_on_hand AS INT) AS qty_on_hand,
        CAST(qty_reserved AS INT) AS qty_reserved,
        CAST(reorder_point AS INT) AS reorder_point,
        CAST(last_restocked_at AS TIMESTAMP) AS last_restocked_at,
        _ingested_at,
        current_timestamp() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN product_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_product_id,
        CASE WHEN qty_on_hand < 0 THEN TRUE ELSE FALSE END AS _is_negative_qty,
        CASE WHEN qty_reserved < 0 THEN TRUE ELSE FALSE END AS _is_negative_reserved,
        CASE WHEN qty_reserved > qty_on_hand THEN TRUE ELSE FALSE END AS _is_overreserved
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_product_id OR _is_negative_qty
        OR _is_negative_reserved OR _is_overreserved
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_product_id THEN 'product_id null' END,
        CASE WHEN _is_negative_qty THEN 'qty_on_hand negative' END,
        CASE WHEN _is_negative_reserved THEN 'qty_reserved negative' END,
        CASE WHEN _is_overreserved THEN 'qty_reserved exceeds qty_on_hand' END
    ) AS validation_errors
FROM validated
