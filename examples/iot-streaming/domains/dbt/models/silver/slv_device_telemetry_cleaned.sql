{{ config(
    materialized='incremental',
    unique_key='telemetry_sk',
    tags=['silver', 'iot', 'telemetry', 'cleaned'],
    on_schema_change='sync_all_columns'
) }}

{#
    Silver layer: deduplicated, schema-validated, UTC-normalized device
    telemetry.

    Transformations applied:
      - Dedup: keep the first record per (device_id, metric_type, event_time)
        within the configured dedup window.
      - Timezone normalization: all timestamps cast to UTC.
      - Range validation: joins sensor_metadata seed for per-metric
        min_valid / max_valid bounds.
      - Device enrichment: joins devices seed for type, location, vendor.
      - Bronze quality flag carried forward; is_valid derived from range
        check + quality_flag not BAD/MISSING.

    Downstream models (silver anomaly flags, gold aggregates) filter on
    is_valid = TRUE.
#}

WITH raw_bronze AS (
    SELECT * FROM {{ ref('brz_iot_telemetry') }}

    {% if is_incremental() %}
        WHERE ingestion_ts > (SELECT COALESCE(MAX(ingestion_ts), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
),

-- Dedup within the configured window. ROW_NUMBER over the dedup partition
-- keeps the earliest-ingested record for any duplicate reading.
deduped AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY
                device_id,
                metric_type,
                CAST(event_time AS TIMESTAMP)
            ORDER BY ingestion_ts ASC, record_hash ASC
        ) AS _dedup_rank
    FROM raw_bronze
),

-- Enrich with device catalog and sensor metadata (seeds)
enriched AS (
    SELECT
        MD5(CONCAT_WS('|',
            d.device_id,
            d.metric_type,
            CAST(d.event_time AS STRING)
        )) AS telemetry_sk,

        d.device_id,
        d.metric_type,

        -- UTC normalization (bronze casts to TIMESTAMP already; re-cast for
        -- clarity and to ensure timezone semantics are explicit on Delta)
        CAST(d.event_time AS TIMESTAMP) AS event_time_utc,
        DATE(d.event_time) AS event_date_utc,
        HOUR(d.event_time) AS event_hour_utc,

        d.value,
        d.quality_flag AS source_quality_flag,

        -- Device enrichment (LEFT JOIN so unknown devices still land in silver)
        dev.type AS device_type,
        dev.vendor AS device_vendor,
        dev.location_lat,
        dev.location_lon,
        dev.install_date,

        -- Metric metadata
        sm.unit AS metric_unit,
        sm.min_valid AS metric_min_valid,
        sm.max_valid AS metric_max_valid,

        -- Range validation
        CASE
            WHEN sm.min_valid IS NULL OR sm.max_valid IS NULL THEN TRUE
            WHEN d.value IS NULL THEN FALSE
            WHEN d.value < sm.min_valid OR d.value > sm.max_valid THEN FALSE
            ELSE TRUE
        END AS in_range,

        -- Composite validity flag
        CASE
            WHEN d.quality_flag IN ('BAD', 'MISSING') THEN FALSE
            WHEN d.value IS NULL THEN FALSE
            WHEN sm.min_valid IS NOT NULL AND sm.max_valid IS NOT NULL
                 AND (d.value < sm.min_valid OR d.value > sm.max_valid) THEN FALSE
            ELSE TRUE
        END AS is_valid,

        -- Ingestion latency (seconds from event_time -> bronze ingestion_ts)
        CAST(
            UNIX_TIMESTAMP(d.ingestion_ts) - UNIX_TIMESTAMP(d.event_time)
            AS BIGINT
        ) AS ingestion_latency_sec,

        d.ingestion_ts,
        d.source_system,
        d.record_hash,

        CURRENT_TIMESTAMP() AS processed_ts

    FROM deduped d
    LEFT JOIN {{ ref('devices') }} dev
        ON dev.device_id = d.device_id
    LEFT JOIN {{ ref('sensor_metadata') }} sm
        ON sm.metric_type = d.metric_type
    WHERE d._dedup_rank = 1
)

SELECT * FROM enriched
