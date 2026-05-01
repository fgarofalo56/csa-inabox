-- ==========================================================================
-- Staging Model: Maintenance Event Logs
-- Source: Bronze layer - work orders and maintenance records from CMMS
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='work_order_id',
    schema='bronze'
) }}

SELECT
    work_order_id                                   AS work_order_id,
    equipment_id                                    AS equipment_id,
    CAST(maintenance_type AS STRING)                AS maintenance_type,
    CAST(description AS STRING)                     AS description,
    CAST(start_time AS TIMESTAMP)                   AS start_time,
    CAST(end_time AS TIMESTAMP)                     AS end_time,
    CAST(technician AS STRING)                      AS technician,
    CAST(root_cause AS STRING)                      AS root_cause,
    CAST(parts_replaced AS STRING)                  AS parts_replaced,
    CAST(cost AS DOUBLE)                            AS cost,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('iot_raw', 'raw_maintenance_logs') }}

{% if is_incremental() %}
WHERE CAST(start_time AS TIMESTAMP) > (
    SELECT MAX(start_time) FROM {{ this }}
)
{% endif %}
