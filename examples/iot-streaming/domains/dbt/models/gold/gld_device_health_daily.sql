{{ config(
    materialized='table',
    tags=['gold', 'iot', 'device_health']
) }}

{#
    Gold layer: daily device-health roll-up.

    One row per (device_id, report_date) with:
      - uptime_pct: share of 1-minute windows that contained at least one
        valid reading (out of 1440 daily windows).
      - data_completeness_pct: valid reading count / expected reading count,
        clamped to 100%.
      - alert_count: number of anomalies flagged in slv_anomaly_flags that
        day for this device.
      - anomaly_rate: anomalies / total readings.
      - device metadata (type, vendor, location) carried from the seed.

    Powers the fleet-overview Power BI page.
#}

WITH daily_minute_buckets AS (
    SELECT
        device_id,
        DATE(window_start) AS report_date,
        COUNT(DISTINCT window_start) AS active_minutes,
        SUM(reading_count) AS total_readings,
        AVG(mean_value) AS mean_of_means
    FROM {{ ref('slv_sensor_aggregates_1min') }}
    GROUP BY device_id, DATE(window_start)
),

daily_anomalies AS (
    SELECT
        device_id,
        DATE(event_time_utc) AS report_date,
        SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS alert_count,
        COUNT(*) AS reading_count_for_anomaly,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_alerts,
        SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning_alerts
    FROM {{ ref('slv_anomaly_flags') }}
    GROUP BY device_id, DATE(event_time_utc)
),

device_catalog AS (
    SELECT
        device_id,
        type AS device_type,
        vendor AS device_vendor,
        location_lat,
        location_lon,
        install_date
    FROM {{ ref('devices') }}
)

SELECT
    mb.report_date,
    mb.device_id,
    dc.device_type,
    dc.device_vendor,
    dc.location_lat,
    dc.location_lon,
    dc.install_date,

    mb.active_minutes,
    mb.total_readings,
    ROUND(mb.mean_of_means, 4) AS mean_value_of_day,

    -- 1440 minutes per day; clamp to [0, 100]
    LEAST(100.0, ROUND(100.0 * mb.active_minutes / 1440.0, 2)) AS uptime_pct,

    -- Expected: one reading per metric per 5 seconds = 17280/day per metric.
    -- We do not know active metric count at this layer, so report a coarse
    -- completeness ratio using active_minutes as the denominator.
    LEAST(100.0, ROUND(100.0 * mb.total_readings / NULLIF(mb.active_minutes * 12, 0), 2))
        AS data_completeness_pct,

    COALESCE(da.alert_count, 0) AS alert_count,
    COALESCE(da.critical_alerts, 0) AS critical_alerts,
    COALESCE(da.warning_alerts, 0) AS warning_alerts,

    CASE
        WHEN mb.total_readings IS NULL OR mb.total_readings = 0 THEN 0.0
        ELSE ROUND(1.0 * COALESCE(da.alert_count, 0) / mb.total_readings, 6)
    END AS anomaly_rate,

    CURRENT_TIMESTAMP() AS processed_ts

FROM daily_minute_buckets mb
LEFT JOIN daily_anomalies da
    ON da.device_id = mb.device_id
   AND da.report_date = mb.report_date
LEFT JOIN device_catalog dc
    ON dc.device_id = mb.device_id
