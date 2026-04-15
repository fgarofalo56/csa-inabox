{{ config(
    materialized='incremental',
    unique_key=['site_id', 'measurement_date', 'parameter_code'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'usgs', 'water', 'hydrology']
) }}

{#
    Bronze Layer: USGS Water Gauge Data

    Source: USGS National Water Information System (NWIS)
    API: https://waterservices.usgs.gov/nwis/
    Coverage: 13,000+ active stream gauges and groundwater monitoring wells

    Parameter codes:
    - 00060: Streamflow (discharge), cubic feet per second (cfs)
    - 00065: Gauge height, feet
    - 72019: Depth to water level below land surface, feet
    - 00010: Water temperature, degrees Celsius
    - 00300: Dissolved oxygen, mg/L
    - 00400: pH

    Data types:
    - iv: Instantaneous values (15-minute intervals)
    - dv: Daily values (daily mean, min, max)
    - stat: Monthly/annual statistics

    This model ingests daily mean values for streamflow and gauge height,
    plus instantaneous values from the real-time Event Hub stream.
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'USGS_NWIS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Site identification
        site_id,               -- USGS site number (e.g., '09380000')
        site_name,
        CAST(site_latitude AS DECIMAL(9, 6)) AS site_latitude,
        CAST(site_longitude AS DECIMAL(9, 6)) AS site_longitude,

        -- Site characteristics
        site_type,             -- 'ST' (stream), 'GW' (groundwater), 'LK' (lake)
        state_code,
        county_code,
        huc_code,              -- Hydrologic Unit Code (watershed)
        drainage_area_sq_mi,

        -- Time dimension
        CAST(measurement_date AS DATE) AS measurement_date,
        CAST(measurement_datetime AS TIMESTAMP) AS measurement_datetime,

        -- Parameter identification
        parameter_code,        -- '00060', '00065', etc.
        parameter_name,
        parameter_unit,

        -- Measurement values
        CAST(value AS DECIMAL(14, 4)) AS value,
        CAST(daily_mean AS DECIMAL(14, 4)) AS daily_mean,
        CAST(daily_min AS DECIMAL(14, 4)) AS daily_min,
        CAST(daily_max AS DECIMAL(14, 4)) AS daily_max,

        -- Data quality from USGS
        qualification_code,    -- 'A' (approved), 'P' (provisional), 'e' (estimated)

        -- Flood and drought reference levels
        CAST(action_stage_ft AS DECIMAL(8, 2)) AS action_stage_ft,
        CAST(flood_stage_ft AS DECIMAL(8, 2)) AS flood_stage_ft,
        CAST(moderate_flood_stage_ft AS DECIMAL(8, 2)) AS moderate_flood_stage_ft,
        CAST(major_flood_stage_ft AS DECIMAL(8, 2)) AS major_flood_stage_ft,

        -- Historical statistics for percentile calculation
        CAST(percentile_10 AS DECIMAL(14, 4)) AS percentile_10,
        CAST(percentile_25 AS DECIMAL(14, 4)) AS percentile_25,
        CAST(percentile_50 AS DECIMAL(14, 4)) AS percentile_50,
        CAST(percentile_75 AS DECIMAL(14, 4)) AS percentile_75,
        CAST(percentile_90 AS DECIMAL(14, 4)) AS percentile_90,

        -- Data quality flags
        CASE
            WHEN site_id IS NULL THEN FALSE
            WHEN measurement_date IS NULL AND measurement_datetime IS NULL THEN FALSE
            WHEN parameter_code IS NULL THEN FALSE
            WHEN value IS NULL AND daily_mean IS NULL THEN FALSE
            WHEN value < -999 THEN FALSE  -- USGS sentinel for missing
            WHEN site_latitude IS NULL OR site_longitude IS NULL THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN site_id IS NULL THEN 'Missing site ID'
            WHEN measurement_date IS NULL AND measurement_datetime IS NULL THEN 'Missing date'
            WHEN parameter_code IS NULL THEN 'Missing parameter code'
            WHEN value IS NULL AND daily_mean IS NULL THEN 'Missing measurement value'
            WHEN value < -999 THEN 'Sentinel value (missing data)'
            WHEN site_latitude IS NULL OR site_longitude IS NULL THEN 'Missing site coordinates'
            ELSE NULL
        END AS validation_errors,

        -- Ingestion metadata
        COALESCE(_source, 'BATCH') AS ingestion_mode,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Record hash
        MD5(CONCAT_WS('|',
            COALESCE(site_id, ''),
            COALESCE(CAST(measurement_date AS STRING), ''),
            COALESCE(parameter_code, '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('interior', 'usgs_water_gauges') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND site_id IS NOT NULL
    AND (measurement_date IS NOT NULL OR measurement_datetime IS NOT NULL)
    AND parameter_code IS NOT NULL
