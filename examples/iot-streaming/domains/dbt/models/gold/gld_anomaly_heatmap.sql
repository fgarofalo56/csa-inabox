{{ config(
    materialized='table',
    tags=['gold', 'iot', 'anomaly', 'heatmap']
) }}

{#
    Gold layer: hour x metric-type anomaly heatmap.

    One row per (report_date, hour_of_day, metric_type) with anomaly
    counts and rates. Powers the heatmap visual on the IoT dashboard that
    surfaces time-of-day patterns in sensor misbehavior.
#}

WITH anomalies_with_context AS (
    SELECT
        DATE(event_time_utc) AS report_date,
        HOUR(event_time_utc) AS hour_of_day,
        metric_type,
        is_anomaly,
        severity,
        anomaly_method
    FROM {{ ref('slv_anomaly_flags') }}
)

SELECT
    report_date,
    hour_of_day,
    metric_type,

    COUNT(*) AS reading_count,
    SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) AS anomaly_count,
    SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
    SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning_count,
    SUM(CASE WHEN anomaly_method = 'zscore' THEN 1 ELSE 0 END) AS zscore_count,
    SUM(CASE WHEN anomaly_method = 'iqr' THEN 1 ELSE 0 END) AS iqr_count,
    SUM(CASE WHEN anomaly_method = 'threshold' THEN 1 ELSE 0 END) AS threshold_count,
    SUM(CASE WHEN anomaly_method = 'combined' THEN 1 ELSE 0 END) AS combined_count,

    ROUND(
        100.0 * SUM(CASE WHEN is_anomaly THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0),
        4
    ) AS anomaly_rate_pct,

    CURRENT_TIMESTAMP() AS processed_ts

FROM anomalies_with_context
GROUP BY report_date, hour_of_day, metric_type
