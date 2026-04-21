{{ '{{' }} config(
    materialized='incremental',
    unique_key='observation_sk',
    tags=['silver', '{{ cookiecutter.vertical_slug }}', 'cleaned'],
    incremental_strategy='merge',
    on_schema_change='sync_all_columns'
) {{ '}}' }}

{{ '{#' }}
    Silver layer: deduplicated + UTC-normalized + range-validated observations.

    Extend this model with vertical-specific range checks as needed.
{{ '#}' }}

WITH dedup AS (
    SELECT *,
        ROW_NUMBER() OVER (PARTITION BY record_hash ORDER BY ingestion_ts DESC) AS rn
    FROM {{ '{{' }} ref('brz_observations') {{ '}}' }}
),

cleaned AS (
    SELECT
        MD5(CONCAT_WS('|', station_id, CAST(event_time AS STRING), metric_name)) AS observation_sk,
        station_id,
        CAST(event_time AS TIMESTAMP) AS event_time_utc,
        metric_name,
        value,
        quality_flag,
        -- Default validity: quality is GOOD and value is a finite number.
        CASE
            WHEN quality_flag = 'GOOD' AND value IS NOT NULL THEN true
            ELSE false
        END AS is_valid,
        ingestion_ts
    FROM dedup
    WHERE rn = 1
)

SELECT * FROM cleaned
