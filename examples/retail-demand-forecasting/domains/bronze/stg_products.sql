-- ==========================================================================
-- Staging Model: Raw Product Catalog
-- Source: Bronze layer - ERP product master extract
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='sku',
    schema='bronze'
) }}

SELECT
    CAST(sku AS STRING)                             AS sku,
    CAST(product_name AS STRING)                    AS product_name,
    CAST(category AS STRING)                        AS category,
    CAST(subcategory AS STRING)                     AS subcategory,
    CAST(brand AS STRING)                           AS brand,
    CAST(unit_cost AS DECIMAL(10,2))                AS unit_cost,
    CAST(unit_msrp AS DECIMAL(10,2))                AS unit_msrp,
    CAST(pack_size AS STRING)                       AS pack_size,
    CAST(is_active AS BOOLEAN)                      AS is_active,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('pos_raw', 'raw_products') }}

{% if is_incremental() %}
WHERE CAST(updated_at AS TIMESTAMP) > (
    SELECT MAX(ingested_at) FROM {{ this }}
)
{% endif %}
