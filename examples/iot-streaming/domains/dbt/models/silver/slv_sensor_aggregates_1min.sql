{{ config(
    materialized='incremental',
    unique_key=['device_id', 'metric_type', 'window_start'],
    tags=['silver', 'iot', 'aggregates'],
    on_schema_change='sync_all_columns'
) }}

{#
    Silver layer: 1-minute tumbling-window aggregates per device + metric.

    Mirrors the Stream Analytics warm-path aggregates in
    stream-analytics/aggregate_metrics.asaql but computed in batch against
    the cleaned silver table. This is the fixture used by
    gld_device_health_daily and gld_anomaly_heatmap.
#}

WITH valid_telemetry AS (
    SELECT
        device_id,
        metric_type,
        event_time_utc,
        value
    FROM {{ ref('slv_device_telemetry_cleaned') }}
    WHERE is_valid = TRUE

    {% if is_incremental() %}
        AND event_time_utc > (SELECT COALESCE(MAX(window_start), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
),

bucketed AS (
    SELECT
        device_id,
        metric_type,
        -- Floor to 1-minute boundary (UTC tumbling window)
        DATE_TRUNC('MINUTE', event_time_utc) AS window_start,
        value
    FROM valid_telemetry
)

SELECT
    window_start,
    window_start + INTERVAL 1 MINUTE AS window_end,
    device_id,
    metric_type,
    COUNT(*) AS reading_count,
    AVG(value) AS mean_value,
    MIN(value) AS min_value,
    MAX(value) AS max_value,
    STDDEV(value) AS stddev_value,
    PERCENTILE_APPROX(value, 0.50) AS p50_value,
    PERCENTILE_APPROX(value, 0.95) AS p95_value,
    PERCENTILE_APPROX(value, 0.99) AS p99_value,
    CURRENT_TIMESTAMP() AS processed_ts
FROM bucketed
GROUP BY window_start, device_id, metric_type
