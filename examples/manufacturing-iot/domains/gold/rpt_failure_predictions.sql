-- ==========================================================================
-- Gold Report: Failure Predictions
-- Aggregates sensor statistics and maintenance history into feature vectors,
-- then applies a scoring formula as a proxy for ML-based failure prediction.
-- In production, replace the heuristic score with an ML model endpoint call.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH recent_readings AS (
    SELECT
        equipment_id,
        sensor_type,
        AVG(reading_value)                          AS avg_value,
        STDDEV(reading_value)                       AS stddev_value,
        MAX(reading_value)                          AS max_value,
        MIN(reading_value)                          AS min_value,
        SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END)
                                                    AS anomaly_count,
        COUNT(*)                                    AS reading_count
    FROM {{ ref('fct_sensor_readings') }}
    WHERE reading_timestamp >= DATEADD(DAY, -7, CURRENT_DATE())
    GROUP BY equipment_id, sensor_type
),

sensor_features AS (
    SELECT
        equipment_id,

        -- Vibration features
        MAX(CASE WHEN sensor_type = 'vibration_mm_s' THEN avg_value END)
                                                    AS vibration_avg,
        MAX(CASE WHEN sensor_type = 'vibration_mm_s' THEN stddev_value END)
                                                    AS vibration_stddev,
        MAX(CASE WHEN sensor_type = 'vibration_mm_s' THEN anomaly_count END)
                                                    AS vibration_anomalies,

        -- Temperature features
        MAX(CASE WHEN sensor_type = 'temperature_c' THEN avg_value END)
                                                    AS temperature_avg,
        MAX(CASE WHEN sensor_type = 'temperature_c' THEN max_value END)
                                                    AS temperature_max,
        MAX(CASE WHEN sensor_type = 'temperature_c' THEN anomaly_count END)
                                                    AS temperature_anomalies,

        -- Pressure features
        MAX(CASE WHEN sensor_type = 'pressure_bar' THEN avg_value END)
                                                    AS pressure_avg,
        MAX(CASE WHEN sensor_type = 'pressure_bar' THEN stddev_value END)
                                                    AS pressure_stddev,

        -- Total anomaly count across all sensors
        SUM(anomaly_count)                          AS total_anomalies

    FROM recent_readings
    GROUP BY equipment_id
),

scored AS (
    SELECT
        sf.equipment_id,
        e.equipment_type,
        e.line_id,
        e.plant_id,
        e.age_years,
        e.days_since_maintenance,
        e.unplanned_maintenance_count,
        e.age_risk_tier,

        sf.vibration_avg,
        sf.vibration_stddev,
        sf.vibration_anomalies,
        sf.temperature_avg,
        sf.temperature_max,
        sf.temperature_anomalies,
        sf.pressure_avg,
        sf.pressure_stddev,
        sf.total_anomalies,

        -- Heuristic failure probability (0.0 - 1.0)
        -- In production, replace this with an ML model scoring call.
        ROUND(LEAST(1.0,
            0.05                                              -- baseline
            + COALESCE(sf.total_anomalies, 0) * 0.02         -- anomaly penalty
            + COALESCE(e.age_years, 0) * 0.01                -- age factor
            + COALESCE(e.days_since_maintenance, 0) * 0.001  -- maintenance gap
            + COALESCE(sf.vibration_stddev, 0) * 0.05        -- vibration instability
            + COALESCE(e.unplanned_maintenance_count, 0) * 0.03  -- history penalty
        ), 3)                                       AS failure_probability,

        CURRENT_TIMESTAMP()                         AS scored_at

    FROM sensor_features sf
    LEFT JOIN {{ ref('dim_equipment') }} e
        ON sf.equipment_id = e.equipment_id
),

tiered AS (
    SELECT
        *,
        CASE
            WHEN failure_probability >= 0.75 THEN 'Critical'
            WHEN failure_probability >= 0.50 THEN 'High'
            WHEN failure_probability >= 0.25 THEN 'Medium'
            ELSE 'Low'
        END                                         AS risk_tier
    FROM scored
)

SELECT * FROM tiered
ORDER BY failure_probability DESC
