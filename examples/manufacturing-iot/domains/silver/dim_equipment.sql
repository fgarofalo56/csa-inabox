-- ==========================================================================
-- Dimension Model: Equipment
-- Enriches equipment master data with age calculations, risk profiling,
-- and latest maintenance context.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

WITH raw_equipment AS (
    SELECT * FROM {{ ref('stg_equipment') }}
    WHERE status != 'DECOMMISSIONED'
),

latest_maintenance AS (
    SELECT
        equipment_id,
        MAX(start_time)                             AS last_maintenance_date,
        COUNT(*)                                    AS total_maintenance_count,
        SUM(CASE WHEN maintenance_type = 'unplanned' THEN 1 ELSE 0 END)
                                                    AS unplanned_count
    FROM {{ ref('stg_maintenance_logs') }}
    GROUP BY equipment_id
),

enriched AS (
    SELECT
        e.equipment_id,
        e.equipment_name,
        e.equipment_type,
        e.line_id,
        e.plant_id,
        e.manufacturer,
        e.model_number,
        e.install_date,
        e.last_overhaul_date,
        e.status,

        -- Age calculations
        DATEDIFF(DAY, e.install_date, CURRENT_DATE())
                                                    AS age_days,
        ROUND(DATEDIFF(DAY, e.install_date, CURRENT_DATE()) / 365.25, 1)
                                                    AS age_years,

        -- Days since last overhaul
        DATEDIFF(DAY, e.last_overhaul_date, CURRENT_DATE())
                                                    AS days_since_overhaul,

        -- Maintenance history
        COALESCE(m.last_maintenance_date, e.install_date)
                                                    AS last_maintenance_date,
        COALESCE(m.total_maintenance_count, 0)      AS total_maintenance_count,
        COALESCE(m.unplanned_count, 0)              AS unplanned_maintenance_count,

        -- Days since last maintenance
        DATEDIFF(DAY,
            COALESCE(m.last_maintenance_date, e.install_date),
            CURRENT_DATE()
        )                                           AS days_since_maintenance,

        -- Age-based risk tier
        CASE
            WHEN DATEDIFF(DAY, e.install_date, CURRENT_DATE()) / 365.25 > 15
                THEN 'Critical'
            WHEN DATEDIFF(DAY, e.install_date, CURRENT_DATE()) / 365.25 > 10
                THEN 'High'
            WHEN DATEDIFF(DAY, e.install_date, CURRENT_DATE()) / 365.25 > 5
                THEN 'Medium'
            ELSE 'Low'
        END                                         AS age_risk_tier,

        CURRENT_TIMESTAMP()                         AS updated_at

    FROM raw_equipment e
    LEFT JOIN latest_maintenance m
        ON e.equipment_id = m.equipment_id
)

SELECT * FROM enriched
