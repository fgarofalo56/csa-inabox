-- ==========================================================================
-- Fact Model: Maintenance Events
-- Structures maintenance logs into planned vs. unplanned events with
-- duration calculations and equipment context.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='work_order_id',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_maintenance_logs') }}
),

enriched AS (
    SELECT
        m.work_order_id,
        m.equipment_id,
        m.maintenance_type,
        m.description,
        m.start_time,
        m.end_time,
        m.technician,
        m.root_cause,
        m.parts_replaced,
        m.cost,

        -- Duration in hours
        ROUND(
            CAST(DATEDIFF(MINUTE, m.start_time, m.end_time) AS DOUBLE) / 60.0,
            2
        )                                               AS duration_hours,

        -- Classification
        CASE
            WHEN m.maintenance_type = 'planned'   THEN 'Preventive'
            WHEN m.maintenance_type = 'unplanned'
             AND m.root_cause IS NOT NULL           THEN 'Corrective'
            WHEN m.maintenance_type = 'unplanned'  THEN 'Breakdown'
            ELSE 'Other'
        END                                             AS maintenance_category,

        -- Equipment context
        e.equipment_type,
        e.line_id,
        e.plant_id,
        e.age_years,
        e.age_risk_tier,

        m.ingested_at,
        CURRENT_TIMESTAMP()                             AS processed_at

    FROM staged m
    LEFT JOIN {{ ref('dim_equipment') }} e
        ON m.equipment_id = e.equipment_id
)

SELECT * FROM enriched

{% if is_incremental() %}
WHERE start_time > (
    SELECT MAX(start_time) FROM {{ this }}
)
{% endif %}
