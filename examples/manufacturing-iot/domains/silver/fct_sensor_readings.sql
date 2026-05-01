-- ==========================================================================
-- Fact Model: Sensor Readings (Cleansed & Enriched)
-- Validates sensor readings and computes rolling statistics for anomaly
-- detection. Joins with equipment dimension for operational context.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='reading_id',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_sensor_telemetry') }}
    WHERE quality_flag != 'BAD'
      AND reading_value IS NOT NULL
),

with_equipment AS (
    SELECT
        s.reading_id,
        s.device_id,
        s.equipment_id,
        s.sensor_type,
        s.reading_value,
        s.unit,
        s.reading_timestamp,
        s.quality_flag,
        s.ingested_at,
        e.equipment_type,
        e.line_id,
        e.plant_id
    FROM staged s
    LEFT JOIN {{ ref('dim_equipment') }} e
        ON s.equipment_id = e.equipment_id
),

with_rolling_stats AS (
    SELECT
        *,

        -- Rolling 1-hour average and standard deviation
        AVG(reading_value) OVER (
            PARTITION BY equipment_id, sensor_type
            ORDER BY reading_timestamp
            RANGE BETWEEN INTERVAL 1 HOUR PRECEDING AND CURRENT ROW
        )                                               AS rolling_avg_1h,

        STDDEV(reading_value) OVER (
            PARTITION BY equipment_id, sensor_type
            ORDER BY reading_timestamp
            RANGE BETWEEN INTERVAL 1 HOUR PRECEDING AND CURRENT ROW
        )                                               AS rolling_stddev_1h,

        -- Rolling 24-hour average
        AVG(reading_value) OVER (
            PARTITION BY equipment_id, sensor_type
            ORDER BY reading_timestamp
            RANGE BETWEEN INTERVAL 24 HOUR PRECEDING AND CURRENT ROW
        )                                               AS rolling_avg_24h,

        -- Min/max in the last hour
        MIN(reading_value) OVER (
            PARTITION BY equipment_id, sensor_type
            ORDER BY reading_timestamp
            RANGE BETWEEN INTERVAL 1 HOUR PRECEDING AND CURRENT ROW
        )                                               AS rolling_min_1h,

        MAX(reading_value) OVER (
            PARTITION BY equipment_id, sensor_type
            ORDER BY reading_timestamp
            RANGE BETWEEN INTERVAL 1 HOUR PRECEDING AND CURRENT ROW
        )                                               AS rolling_max_1h

    FROM with_equipment
),

enriched AS (
    SELECT
        reading_id,
        device_id,
        equipment_id,
        sensor_type,
        reading_value,
        unit,
        reading_timestamp,
        quality_flag,
        equipment_type,
        line_id,
        plant_id,
        rolling_avg_1h,
        rolling_stddev_1h,
        rolling_avg_24h,
        rolling_min_1h,
        rolling_max_1h,

        -- Z-score for anomaly detection
        CASE
            WHEN rolling_stddev_1h > 0
            THEN ROUND((reading_value - rolling_avg_1h) / rolling_stddev_1h, 2)
            ELSE 0.0
        END                                             AS z_score,

        -- Anomaly flag (|z| > 3)
        CASE
            WHEN rolling_stddev_1h > 0
             AND ABS((reading_value - rolling_avg_1h) / rolling_stddev_1h) > 3.0
            THEN TRUE
            ELSE FALSE
        END                                             AS is_anomaly,

        ingested_at,
        CURRENT_TIMESTAMP()                             AS processed_at

    FROM with_rolling_stats
)

SELECT * FROM enriched

{% if is_incremental() %}
WHERE reading_timestamp > (
    SELECT MAX(reading_timestamp) FROM {{ this }}
)
{% endif %}
