{{ config(
    materialized='table',
    tags=['gold', 'iot', 'sla']
) }}

{#
    Gold layer: per-device latency-SLO compliance, rolled up per 15-minute
    bucket.

    Uses ingestion_latency_sec from slv_device_telemetry_cleaned (event_time
    -> bronze ingestion_ts). Each bucket reports:
      - within_sla_count:   latency <= sla_latency_warn_sec
      - warn_count:          warn < latency <= breach
      - breach_count:        latency > sla_latency_breach_sec
      - p50 / p95 / p99 latency
      - compliance_pct:      within_sla_count / total (%)

    Powers the SLO-compliance tiles on the IoT dashboard.
#}

WITH latency_records AS (
    SELECT
        device_id,
        event_time_utc,
        ingestion_latency_sec
    FROM {{ ref('slv_device_telemetry_cleaned') }}
    WHERE ingestion_latency_sec IS NOT NULL
      AND ingestion_latency_sec >= 0
),

bucketed AS (
    SELECT
        device_id,
        -- Truncate to 15-minute boundary
        FROM_UNIXTIME(
            CAST(UNIX_TIMESTAMP(event_time_utc) / 900 AS BIGINT) * 900
        ) AS bucket_start,
        ingestion_latency_sec
    FROM latency_records
)

SELECT
    bucket_start,
    bucket_start + INTERVAL 15 MINUTE AS bucket_end,
    device_id,

    COUNT(*) AS total_readings,

    SUM(CASE
        WHEN ingestion_latency_sec <= {{ var('sla_latency_warn_sec') }} THEN 1 ELSE 0
    END) AS within_sla_count,

    SUM(CASE
        WHEN ingestion_latency_sec > {{ var('sla_latency_warn_sec') }}
         AND ingestion_latency_sec <= {{ var('sla_latency_breach_sec') }} THEN 1 ELSE 0
    END) AS warn_count,

    SUM(CASE
        WHEN ingestion_latency_sec > {{ var('sla_latency_breach_sec') }} THEN 1 ELSE 0
    END) AS breach_count,

    PERCENTILE_APPROX(ingestion_latency_sec, 0.50) AS p50_latency_sec,
    PERCENTILE_APPROX(ingestion_latency_sec, 0.95) AS p95_latency_sec,
    PERCENTILE_APPROX(ingestion_latency_sec, 0.99) AS p99_latency_sec,
    MAX(ingestion_latency_sec) AS max_latency_sec,

    ROUND(
        100.0 * SUM(CASE WHEN ingestion_latency_sec <= {{ var('sla_latency_warn_sec') }} THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0),
        2
    ) AS compliance_pct,

    CURRENT_TIMESTAMP() AS processed_ts

FROM bucketed
GROUP BY bucket_start, device_id
