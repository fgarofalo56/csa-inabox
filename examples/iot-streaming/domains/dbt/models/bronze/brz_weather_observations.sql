{{ config(
    materialized='incremental',
    unique_key=['record_hash'],
    tags=['bronze', 'iot', 'weather'],
    on_schema_change='append_new_columns'
) }}

{#
    Bronze layer: NOAA-style weather station observations arriving via the
    streaming pipeline (Event Hub -> Capture -> ADLS bronze). Same wide shape
    as the ADX WeatherObservations table in kql/tables.kql.
#}

WITH source_data AS (
    SELECT
        COALESCE(station_id, 'UNKNOWN') AS station_id,
        CAST(event_time AS TIMESTAMP) AS event_time,

        CAST(temperature_c AS DOUBLE) AS temperature_c,
        CAST(humidity_pct AS DOUBLE) AS humidity_pct,
        CAST(pressure_hpa AS DOUBLE) AS pressure_hpa,
        CAST(wind_speed_ms AS DOUBLE) AS wind_speed_ms,
        CAST(wind_direction_deg AS DOUBLE) AS wind_direction_deg,
        CAST(wind_gust_ms AS DOUBLE) AS wind_gust_ms,
        CAST(precipitation_mm AS DOUBLE) AS precipitation_mm,
        CAST(visibility_km AS DOUBLE) AS visibility_km,
        CAST(cloud_cover_pct AS DOUBLE) AS cloud_cover_pct,
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,
        CAST(elevation_m AS DECIMAL(8,2)) AS elevation_m,

        UPPER(TRIM(COALESCE(quality_flag, 'GOOD'))) AS quality_flag,

        CURRENT_TIMESTAMP() AS ingestion_ts,
        'EVENT_HUB_CAPTURE' AS source_system,

        MD5(CONCAT_WS('|',
            COALESCE(station_id, ''),
            COALESCE(CAST(event_time AS STRING), ''),
            COALESCE(CAST(temperature_c AS STRING), ''),
            COALESCE(CAST(pressure_hpa AS STRING), '')
        )) AS record_hash

    FROM {{ source('iot', 'weather_capture') }}

    {% if is_incremental() %}
        WHERE event_time > (SELECT COALESCE(MAX(event_time), TIMESTAMP '1970-01-01') FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE station_id IS NOT NULL
  AND station_id <> 'UNKNOWN'
  AND event_time IS NOT NULL
