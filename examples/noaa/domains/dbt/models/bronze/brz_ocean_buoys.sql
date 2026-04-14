{{ config(
    materialized='incremental',
    unique_key=['station_id', 'observation_datetime'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'ndbc', 'ocean_buoys']
) }}

{#
    Bronze layer: Raw NDBC (National Data Buoy Center) observations.

    Ingests ocean buoy meteorological and oceanographic observations including
    wave height, wave period, sea surface temperature, air temperature, wind
    speed/direction, atmospheric pressure, and ocean currents. Data arrives
    from moored buoys, coastal stations, and ships.

    NDBC uses specific missing-value codes (e.g., 99.0 for missing temperature,
    999.0 for missing wind direction) that must be handled in the Silver layer.

    Source: https://www.ndbc.noaa.gov/
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'NDBC' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Station identification
        COALESCE(CAST(station_id AS STRING), 'UNKNOWN') AS station_id,
        station_name,
        station_type,           -- Buoy, C-MAN, Ship, etc.
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,
        CAST(water_depth_m AS DECIMAL(8,2)) AS water_depth_m,

        -- Temporal fields
        CAST(observation_datetime AS TIMESTAMP) AS observation_datetime,
        CAST(observation_date AS DATE) AS observation_date,
        YEAR(CAST(observation_datetime AS TIMESTAMP)) AS observation_year,
        MONTH(CAST(observation_datetime AS TIMESTAMP)) AS observation_month,

        -- Wind measurements (raw)
        CAST(wind_direction_deg AS DECIMAL(5,1)) AS wind_direction_deg_raw,
        CAST(wind_speed_ms AS DECIMAL(6,2)) AS wind_speed_ms_raw,
        CAST(wind_gust_ms AS DECIMAL(6,2)) AS wind_gust_ms_raw,

        -- Wave measurements (raw)
        CAST(wave_height_m AS DECIMAL(5,2)) AS wave_height_m_raw,
        CAST(dominant_wave_period_s AS DECIMAL(5,1)) AS dominant_wave_period_s_raw,
        CAST(average_wave_period_s AS DECIMAL(5,1)) AS average_wave_period_s_raw,
        CAST(mean_wave_direction_deg AS DECIMAL(5,1)) AS mean_wave_direction_deg_raw,

        -- Atmospheric measurements (raw)
        CAST(pressure_hpa AS DECIMAL(7,1)) AS pressure_hpa_raw,
        CAST(air_temperature_c AS DECIMAL(5,1)) AS air_temperature_c_raw,
        CAST(dewpoint_c AS DECIMAL(5,1)) AS dewpoint_c_raw,
        CAST(visibility_nmi AS DECIMAL(5,1)) AS visibility_nmi_raw,

        -- Ocean measurements (raw)
        CAST(sea_surface_temp_c AS DECIMAL(5,2)) AS sea_surface_temp_c_raw,
        CAST(salinity_psu AS DECIMAL(5,2)) AS salinity_psu_raw,
        CAST(ocean_current_speed_ms AS DECIMAL(5,2)) AS current_speed_ms_raw,
        CAST(ocean_current_direction_deg AS DECIMAL(5,1)) AS current_direction_deg_raw,
        CAST(water_level_m AS DECIMAL(6,3)) AS water_level_m_raw,

        -- Data quality flags
        CASE
            WHEN station_id IS NULL OR TRIM(station_id) = '' THEN FALSE
            WHEN observation_datetime IS NULL THEN FALSE
            WHEN CAST(observation_datetime AS TIMESTAMP) > CURRENT_TIMESTAMP() THEN FALSE
            -- NDBC uses 999/99/9999 as missing value sentinels
            WHEN wind_speed_ms = 99.0
                 AND wave_height_m = 99.0
                 AND air_temperature_c = 999.0
                 AND sea_surface_temp_c = 999.0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN station_id IS NULL OR TRIM(station_id) = '' THEN 'Missing station ID'
            WHEN observation_datetime IS NULL THEN 'Missing observation datetime'
            WHEN CAST(observation_datetime AS TIMESTAMP) > CURRENT_TIMESTAMP() THEN 'Future observation'
            WHEN wind_speed_ms = 99.0
                 AND wave_height_m = 99.0
                 AND air_temperature_c = 999.0
                 AND sea_surface_temp_c = 999.0 THEN 'All measurements missing (sentinel values)'
            ELSE NULL
        END AS validation_errors,

        -- Processing metadata
        load_time,
        MD5(CONCAT_WS('|',
            COALESCE(station_id, ''),
            COALESCE(CAST(observation_datetime AS STRING), ''),
            COALESCE(CAST(wave_height_m AS STRING), ''),
            COALESCE(CAST(sea_surface_temp_c AS STRING), '')
        )) AS record_hash,

        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('noaa', 'ndbc_buoy') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND station_id IS NOT NULL
    AND observation_datetime IS NOT NULL
