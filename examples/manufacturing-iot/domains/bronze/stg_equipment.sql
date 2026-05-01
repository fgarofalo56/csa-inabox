-- ==========================================================================
-- Staging Model: Equipment Master Data
-- Source: Bronze layer - equipment registry from ERP/CMMS
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='equipment_id',
    schema='bronze'
) }}

SELECT
    equipment_id                                    AS equipment_id,
    CAST(equipment_name AS STRING)                  AS equipment_name,
    CAST(equipment_type AS STRING)                  AS equipment_type,
    CAST(line_id AS STRING)                         AS line_id,
    CAST(plant_id AS STRING)                        AS plant_id,
    CAST(manufacturer AS STRING)                    AS manufacturer,
    CAST(model_number AS STRING)                    AS model_number,
    CAST(install_date AS DATE)                      AS install_date,
    CAST(last_overhaul_date AS DATE)                AS last_overhaul_date,
    CAST(status AS STRING)                          AS status,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('iot_raw', 'raw_equipment') }}

{% if is_incremental() %}
WHERE CAST(_loaded_at AS TIMESTAMP) > (
    SELECT MAX(ingested_at) FROM {{ this }}
)
{% endif %}
