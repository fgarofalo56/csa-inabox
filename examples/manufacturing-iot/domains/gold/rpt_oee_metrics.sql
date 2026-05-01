-- ==========================================================================
-- Gold Report: Overall Equipment Effectiveness (OEE)
-- Computes Availability, Performance, and Quality factors per equipment
-- per day.  OEE = Availability x Performance x Quality.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH planned_production AS (
    -- Assume 16 planned production hours per day (two 8-hour shifts)
    SELECT
        equipment_id,
        CAST(reading_timestamp AS DATE)             AS report_date,
        16.0                                        AS planned_hours
    FROM {{ ref('fct_sensor_readings') }}
    GROUP BY equipment_id, CAST(reading_timestamp AS DATE)
),

downtime AS (
    SELECT
        equipment_id,
        CAST(start_time AS DATE)                    AS report_date,
        SUM(duration_hours)                         AS total_downtime_hours
    FROM {{ ref('fct_maintenance_events') }}
    GROUP BY equipment_id, CAST(start_time AS DATE)
),

throughput AS (
    -- Use sensor reading count as a proxy for production cycles
    SELECT
        equipment_id,
        CAST(reading_timestamp AS DATE)             AS report_date,
        COUNT(*)                                    AS actual_cycles,
        -- Ideal cycle count based on sensor frequency (1 reading per minute)
        16.0 * 60                                   AS ideal_cycles
    FROM {{ ref('fct_sensor_readings') }}
    WHERE sensor_type = 'vibration_mm_s'
    GROUP BY equipment_id, CAST(reading_timestamp AS DATE)
),

quality AS (
    -- Quality proxy: readings within normal range / total readings
    SELECT
        equipment_id,
        CAST(reading_timestamp AS DATE)             AS report_date,
        COUNT(*)                                    AS total_readings,
        SUM(CASE WHEN is_anomaly = FALSE THEN 1 ELSE 0 END)
                                                    AS good_readings
    FROM {{ ref('fct_sensor_readings') }}
    GROUP BY equipment_id, CAST(reading_timestamp AS DATE)
),

oee AS (
    SELECT
        p.equipment_id,
        p.report_date,

        e.equipment_type,
        e.line_id,
        e.plant_id,

        p.planned_hours,
        COALESCE(d.total_downtime_hours, 0)         AS downtime_hours,

        -- Availability = (Planned - Downtime) / Planned
        ROUND(
            (p.planned_hours - COALESCE(d.total_downtime_hours, 0))
            / p.planned_hours * 100, 2
        )                                           AS availability_pct,

        -- Performance = Actual Cycles / Ideal Cycles
        ROUND(
            COALESCE(t.actual_cycles, 0)
            / NULLIF(t.ideal_cycles, 0) * 100, 2
        )                                           AS performance_pct,

        -- Quality = Good Readings / Total Readings
        ROUND(
            COALESCE(q.good_readings, 0)
            / NULLIF(q.total_readings, 0) * 100, 2
        )                                           AS quality_pct,

        -- OEE = Availability x Performance x Quality (as percentage)
        ROUND(
            ((p.planned_hours - COALESCE(d.total_downtime_hours, 0))
                / p.planned_hours)
            * (COALESCE(t.actual_cycles, 0)
                / NULLIF(t.ideal_cycles, 0))
            * (COALESCE(q.good_readings, 0)
                / NULLIF(q.total_readings, 0))
            * 100, 2
        )                                           AS oee_pct,

        CURRENT_TIMESTAMP()                         AS calculated_at

    FROM planned_production p
    LEFT JOIN downtime d
        ON p.equipment_id = d.equipment_id AND p.report_date = d.report_date
    LEFT JOIN throughput t
        ON p.equipment_id = t.equipment_id AND p.report_date = t.report_date
    LEFT JOIN quality q
        ON p.equipment_id = q.equipment_id AND p.report_date = q.report_date
    LEFT JOIN {{ ref('dim_equipment') }} e
        ON p.equipment_id = e.equipment_id
)

SELECT * FROM oee
ORDER BY report_date DESC, equipment_id
