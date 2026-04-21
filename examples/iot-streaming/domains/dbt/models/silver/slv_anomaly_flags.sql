{{ config(
    materialized='incremental',
    unique_key='telemetry_sk',
    tags=['silver', 'iot', 'anomaly'],
    on_schema_change='sync_all_columns'
) }}

{#
    Silver layer: per-reading anomaly detection.

    Mirrors the spike/dip logic from stream-analytics/detect_anomalies.asaql
    so the warm path (ASA) and batch path (dbt) produce comparable signals.

    Detection methods:
      - zscore:    |value - rolling_mean| / rolling_stddev > threshold
      - iqr:       value outside [Q1 - k*IQR, Q3 + k*IQR]
      - threshold: metric-specific hard thresholds (e.g., temp > 45 C)
      - combined:  any of the above fire

    The rolling window is 120 readings per (device_id, metric_type), which
    matches the ASA LIMIT DURATION(minute, 120) parameter for a ~5s cadence.
#}

WITH base AS (
    SELECT
        telemetry_sk,
        device_id,
        metric_type,
        event_time_utc,
        value,
        is_valid
    FROM {{ ref('slv_device_telemetry_cleaned') }}
    WHERE is_valid = TRUE

    {% if is_incremental() %}
        AND event_time_utc > (SELECT COALESCE(MAX(event_time_utc), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
),

-- Rolling z-score over the trailing 120 readings per device+metric
rolling_stats AS (
    SELECT
        telemetry_sk,
        device_id,
        metric_type,
        event_time_utc,
        value,

        AVG(value) OVER (
            PARTITION BY device_id, metric_type
            ORDER BY event_time_utc
            ROWS BETWEEN 120 PRECEDING AND 1 PRECEDING
        ) AS rolling_mean,

        STDDEV(value) OVER (
            PARTITION BY device_id, metric_type
            ORDER BY event_time_utc
            ROWS BETWEEN 120 PRECEDING AND 1 PRECEDING
        ) AS rolling_stddev,

        -- Approximate IQR via percentile_approx (Spark / Databricks SQL)
        PERCENTILE_APPROX(value, 0.25) OVER (
            PARTITION BY device_id, metric_type
            ORDER BY event_time_utc
            ROWS BETWEEN 120 PRECEDING AND 1 PRECEDING
        ) AS rolling_q1,

        PERCENTILE_APPROX(value, 0.75) OVER (
            PARTITION BY device_id, metric_type
            ORDER BY event_time_utc
            ROWS BETWEEN 120 PRECEDING AND 1 PRECEDING
        ) AS rolling_q3

    FROM base
),

scored AS (
    SELECT
        telemetry_sk,
        device_id,
        metric_type,
        event_time_utc,
        value,
        rolling_mean,
        rolling_stddev,
        rolling_q1,
        rolling_q3,

        -- Z-score (NULL-safe)
        CASE
            WHEN rolling_stddev IS NULL OR rolling_stddev = 0 THEN NULL
            ELSE (value - rolling_mean) / rolling_stddev
        END AS zscore,

        -- IQR fence distance (positive = outside, negative = inside)
        CASE
            WHEN rolling_q1 IS NULL OR rolling_q3 IS NULL THEN NULL
            WHEN value < rolling_q1 - {{ var('iqr_multiplier') }} * (rolling_q3 - rolling_q1)
                THEN rolling_q1 - value
            WHEN value > rolling_q3 + {{ var('iqr_multiplier') }} * (rolling_q3 - rolling_q1)
                THEN value - rolling_q3
            ELSE 0
        END AS iqr_fence_distance

    FROM rolling_stats
),

flagged AS (
    SELECT
        telemetry_sk,
        device_id,
        metric_type,
        event_time_utc,
        value,
        rolling_mean,
        rolling_stddev,
        zscore,
        iqr_fence_distance,

        -- Z-score anomaly
        CASE
            WHEN zscore IS NULL THEN FALSE
            WHEN ABS(zscore) > {{ var('zscore_anomaly_threshold') }} THEN TRUE
            ELSE FALSE
        END AS is_zscore_anomaly,

        -- IQR anomaly
        CASE
            WHEN iqr_fence_distance IS NULL THEN FALSE
            WHEN iqr_fence_distance > 0 THEN TRUE
            ELSE FALSE
        END AS is_iqr_anomaly,

        -- Threshold anomaly (metric-specific)
        CASE
            WHEN metric_type = 'temperature_c' AND value > {{ var('temp_critical_spike_c') }} THEN TRUE
            WHEN metric_type = 'temperature_c' AND value < {{ var('temp_critical_dip_c') }} THEN TRUE
            WHEN metric_type = 'battery_pct' AND value < {{ var('battery_critical_pct') }} THEN TRUE
            ELSE FALSE
        END AS is_threshold_anomaly

    FROM scored
)

SELECT
    telemetry_sk,
    device_id,
    metric_type,
    event_time_utc,
    value,
    rolling_mean,
    rolling_stddev,
    zscore,
    iqr_fence_distance,
    is_zscore_anomaly,
    is_iqr_anomaly,
    is_threshold_anomaly,

    (is_zscore_anomaly OR is_iqr_anomaly OR is_threshold_anomaly) AS is_anomaly,

    CASE
        WHEN is_threshold_anomaly AND (is_zscore_anomaly OR is_iqr_anomaly) THEN 'combined'
        WHEN is_threshold_anomaly THEN 'threshold'
        WHEN is_zscore_anomaly THEN 'zscore'
        WHEN is_iqr_anomaly THEN 'iqr'
        ELSE 'none'
    END AS anomaly_method,

    -- Severity mirrors ASA detect_anomalies.asaql
    CASE
        WHEN metric_type = 'temperature_c' AND (value > {{ var('temp_critical_spike_c') }} OR value < {{ var('temp_critical_dip_c') }})
            THEN 'critical'
        WHEN metric_type = 'temperature_c' AND (value > {{ var('temp_warning_high_c') }} OR value < {{ var('temp_warning_low_c') }})
            THEN 'warning'
        WHEN is_zscore_anomaly OR is_iqr_anomaly THEN 'info'
        ELSE 'none'
    END AS severity,

    CURRENT_TIMESTAMP() AS processed_ts

FROM flagged
