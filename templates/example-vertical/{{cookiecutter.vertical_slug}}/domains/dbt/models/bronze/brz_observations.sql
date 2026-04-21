{{ '{{' }} config(
    materialized='incremental',
    unique_key=['record_hash'],
    tags=['bronze', '{{ cookiecutter.vertical_slug }}', 'observations'],
    on_schema_change='append_new_columns'
) {{ '}}' }}

{{ '{#' }}
    Bronze layer: raw {{ cookiecutter.vertical_name }} observations.

    Sourced from ADLS Gen2 landing-zone files (or seed fixtures produced by
    data/generators/generate_seed.py). No validation beyond required-field
    presence - bad rows survive to bronze so they can be audited.
{{ '#}' }}

WITH source_data AS (
    SELECT
        COALESCE(station_id, 'UNKNOWN') AS station_id,
        CAST(event_time AS TIMESTAMP) AS event_time,
        LOWER(TRIM(metric_name)) AS metric_name,
        CAST(value AS DOUBLE) AS value,
        UPPER(TRIM(COALESCE(quality_flag, 'GOOD'))) AS quality_flag,
        CURRENT_TIMESTAMP() AS ingestion_ts,
        'LANDING_ZONE' AS source_system,

        MD5(CONCAT_WS('|',
            COALESCE(station_id, ''),
            COALESCE(CAST(event_time AS STRING), ''),
            COALESCE(LOWER(metric_name), ''),
            COALESCE(CAST(value AS STRING), '')
        )) AS record_hash

    FROM {{ '{{' }} source('{{ cookiecutter.vertical_slug | replace("-", "_") }}', 'observations_raw') {{ '}}' }}

    {{ '{%' }} if is_incremental() {{ '%}' }}
        WHERE event_time > (SELECT COALESCE(MAX(event_time), TIMESTAMP '1970-01-01') FROM {{ '{{' }} this {{ '}}' }})
    {{ '{%' }} endif {{ '%}' }}
)

SELECT * FROM source_data
WHERE station_id IS NOT NULL
  AND station_id <> 'UNKNOWN'
  AND event_time IS NOT NULL
  AND metric_name IS NOT NULL
