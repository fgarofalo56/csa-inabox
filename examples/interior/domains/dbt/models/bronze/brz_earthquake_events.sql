{{ config(
    materialized='incremental',
    unique_key=['event_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'usgs', 'earthquake', 'seismic']
) }}

{#
    Bronze Layer: Raw USGS Earthquake Events

    Source: USGS Earthquake Hazards Program — ComCat Catalog
    API: https://earthquake.usgs.gov/fdsnws/event/1/
    Format: GeoJSON (FeatureCollection)

    The USGS earthquake catalog is the authoritative source for seismic
    events in the United States and globally. Each event record includes:
    - Location (lat/lon/depth)
    - Magnitude (multiple scales: ml, mb, mw, ms)
    - Timing (origin time in UTC)
    - Quality metrics (number of stations, gap, RMS)
    - Community reports (felt reports, CDI, MMI)

    Catalog completeness:
    - M2.5+ since ~1973 for CONUS
    - M4.0+ since ~1900 globally
    - M7.0+ since ~1500 (historical)

    This model preserves the raw event data with minimal transformation,
    adding source tracking and basic validation flags. Both batch (historical)
    and streaming (real-time) events are ingested here.
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'USGS_COMCAT' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Unique event identifier (USGS event ID, e.g., "us7000m0xl")
        event_id,

        -- Temporal data
        CAST(event_time AS TIMESTAMP) AS event_time,
        CAST(updated_time AS TIMESTAMP) AS updated_time,

        -- Location
        CAST(latitude AS DECIMAL(9, 6)) AS latitude,
        CAST(longitude AS DECIMAL(9, 6)) AS longitude,
        CAST(depth_km AS DECIMAL(6, 2)) AS depth_km,

        -- Magnitude
        CAST(magnitude AS DECIMAL(4, 2)) AS magnitude,
        magnitude_type,  -- 'ml', 'mb', 'mw', 'ms', 'md'

        -- Location description
        place_description,

        -- Event classification
        UPPER(COALESCE(event_type, 'EARTHQUAKE')) AS event_type,
        status,  -- 'automatic', 'reviewed', 'deleted'

        -- Hazard indicators
        CAST(COALESCE(tsunami_flag, 0) AS INT) AS tsunami_flag,
        CAST(felt_reports AS INT) AS felt_reports,

        -- Intensity measures
        CAST(cdi AS DECIMAL(4, 2)) AS cdi,  -- Community Decimal Intensity
        CAST(mmi AS DECIMAL(4, 2)) AS mmi,  -- Modified Mercalli Intensity
        alert_level,  -- 'green', 'yellow', 'orange', 'red'

        -- Quality metrics
        CAST(num_stations AS INT) AS num_stations,
        CAST(azimuthal_gap AS DECIMAL(5, 2)) AS azimuthal_gap,
        CAST(distance_to_nearest_station AS DECIMAL(8, 4)) AS distance_to_nearest_station,
        CAST(rms AS DECIMAL(6, 4)) AS rms,
        CAST(horizontal_error AS DECIMAL(8, 4)) AS horizontal_error,
        CAST(depth_error AS DECIMAL(8, 4)) AS depth_error,
        CAST(magnitude_error AS DECIMAL(4, 2)) AS magnitude_error,

        -- Network information
        network,           -- Contributing seismic network (e.g., 'us', 'ci', 'nc')
        sources,           -- Comma-separated source networks
        types,             -- Available data types

        -- Significance score (USGS composite metric)
        CAST(sig AS INT) AS significance_score,

        -- Data quality flags
        CASE
            WHEN event_id IS NULL THEN FALSE
            WHEN event_time IS NULL THEN FALSE
            WHEN latitude IS NULL OR longitude IS NULL THEN FALSE
            WHEN latitude < -90 OR latitude > 90 THEN FALSE
            WHEN longitude < -180 OR longitude > 180 THEN FALSE
            WHEN magnitude IS NULL THEN FALSE
            WHEN depth_km IS NULL OR depth_km < 0 OR depth_km > 700 THEN FALSE
            WHEN status = 'deleted' THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN event_id IS NULL THEN 'Missing event ID'
            WHEN event_time IS NULL THEN 'Missing event time'
            WHEN latitude IS NULL OR longitude IS NULL THEN 'Missing coordinates'
            WHEN latitude < -90 OR latitude > 90 THEN 'Latitude out of range'
            WHEN longitude < -180 OR longitude > 180 THEN 'Longitude out of range'
            WHEN magnitude IS NULL THEN 'Missing magnitude'
            WHEN depth_km IS NULL OR depth_km < 0 OR depth_km > 700 THEN 'Invalid depth'
            WHEN status = 'deleted' THEN 'Event deleted by USGS'
            ELSE NULL
        END AS validation_errors,

        -- Ingestion metadata
        COALESCE(_source, 'BATCH') AS ingestion_mode,  -- 'BATCH' or 'STREAM'

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(event_id, ''),
            COALESCE(CAST(event_time AS STRING), ''),
            COALESCE(CAST(magnitude AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('interior', 'usgs_earthquakes') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND event_id IS NOT NULL
    AND event_time IS NOT NULL
    AND magnitude IS NOT NULL
    AND event_type = 'EARTHQUAKE'  -- Exclude quarry blasts, explosions, etc.
