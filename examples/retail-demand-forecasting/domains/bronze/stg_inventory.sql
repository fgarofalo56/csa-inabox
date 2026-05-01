-- ==========================================================================
-- Staging Model: Raw Inventory Snapshots
-- Source: Bronze layer - nightly inventory position exports
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='inventory_snapshot_key',
    schema='bronze'
) }}

SELECT
    CONCAT(
        CAST(store_id AS STRING), '|',
        CAST(sku AS STRING), '|',
        CAST(snapshot_date AS STRING)
    )                                               AS inventory_snapshot_key,
    CAST(store_id AS STRING)                        AS store_id,
    CAST(sku AS STRING)                             AS sku,
    CAST(on_hand_qty AS INT)                        AS on_hand_qty,
    CAST(on_order_qty AS INT)                       AS on_order_qty,
    CAST(in_transit_qty AS INT)                     AS in_transit_qty,
    CAST(snapshot_date AS DATE)                     AS snapshot_date,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('pos_raw', 'raw_inventory') }}

{% if is_incremental() %}
WHERE CAST(snapshot_date AS DATE) > (
    SELECT MAX(snapshot_date) FROM {{ this }}
)
{% endif %}
