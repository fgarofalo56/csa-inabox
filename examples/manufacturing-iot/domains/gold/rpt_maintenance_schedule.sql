-- ==========================================================================
-- Gold Report: Maintenance Schedule Recommendations
-- Combines failure predictions with equipment context to recommend
-- optimized maintenance windows that minimize production disruption.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH predictions AS (
    SELECT * FROM {{ ref('rpt_failure_predictions') }}
),

recent_maintenance AS (
    SELECT
        equipment_id,
        MAX(start_time)                             AS last_maintenance_date,
        AVG(duration_hours)                         AS avg_repair_duration
    FROM {{ ref('fct_maintenance_events') }}
    GROUP BY equipment_id
),

schedule AS (
    SELECT
        p.equipment_id,
        p.equipment_type,
        p.line_id,
        p.plant_id,
        p.failure_probability,
        p.risk_tier,
        p.age_years,
        p.days_since_maintenance,
        p.vibration_avg,
        p.temperature_avg,
        p.total_anomalies,

        rm.last_maintenance_date,
        COALESCE(rm.avg_repair_duration, 4.0)       AS estimated_downtime_hours,

        -- Recommended maintenance date based on risk tier
        CASE
            WHEN p.risk_tier = 'Critical'
                THEN DATEADD(DAY, 1, CURRENT_DATE())
            WHEN p.risk_tier = 'High'
                THEN DATEADD(DAY, 7, CURRENT_DATE())
            WHEN p.risk_tier = 'Medium'
                THEN DATEADD(DAY, 30, CURRENT_DATE())
            ELSE DATEADD(DAY, 90, CURRENT_DATE())
        END                                         AS recommended_date,

        -- Priority score for scheduling (higher = more urgent)
        ROUND(
            p.failure_probability * 100
            + COALESCE(p.days_since_maintenance, 0) * 0.1
            + COALESCE(p.total_anomalies, 0) * 2,
            2
        )                                           AS scheduling_priority,

        -- Maintenance type recommendation
        CASE
            WHEN p.risk_tier = 'Critical'
                THEN 'Emergency - Immediate inspection and repair'
            WHEN p.risk_tier = 'High'
                THEN 'Urgent - Schedule within one week'
            WHEN p.risk_tier = 'Medium'
                THEN 'Planned - Include in next maintenance window'
            ELSE 'Monitor - Continue condition monitoring'
        END                                         AS recommendation,

        CURRENT_TIMESTAMP()                         AS generated_at

    FROM predictions p
    LEFT JOIN recent_maintenance rm
        ON p.equipment_id = rm.equipment_id
)

SELECT * FROM schedule
ORDER BY scheduling_priority DESC
