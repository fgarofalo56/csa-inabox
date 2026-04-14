{{ config(
    materialized='incremental',
    unique_key='earthquake_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'earthquake', 'seismic', 'cleaned']
) }}

{#
    Silver Layer: Cleaned Seismic Data with Magnitude Classification and Depth Categorization

    Transforms raw USGS earthquake events into analytics-ready format.

    Key transformations:
    1. Magnitude classification using USGS scale (micro through great)
    2. Depth categorization (shallow, intermediate, deep)
    3. Geographic region assignment based on tectonic setting
    4. Preferred magnitude selection (Mw > mb > ml > md)
    5. Aftershock sequence flagging using space-time windows
    6. Intensity estimation where not directly measured

    Magnitude scale (Richter/moment magnitude):
    - Micro: < 2.0 (not felt)
    - Minor: 2.0-3.9 (rarely felt)
    - Light: 4.0-4.9 (noticeable shaking)
    - Moderate: 5.0-5.9 (damage to weak structures)
    - Strong: 6.0-6.9 (destructive in populated areas)
    - Major: 7.0-7.9 (serious damage over large areas)
    - Great: >= 8.0 (devastating, can destroy communities)

    Depth categories:
    - Shallow: 0-70 km (most destructive)
    - Intermediate: 70-300 km (subduction zones)
    - Deep: 300-700 km (deep subduction, rarely destructive)
#}

WITH base AS (
    SELECT * FROM {{ ref('brz_earthquake_events') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

classified AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            event_id,
            CAST(event_time AS STRING)
        )) AS earthquake_sk,

        event_id,
        event_time,
        updated_time,

        -- Location
        latitude,
        longitude,
        depth_km,

        -- Magnitude (prefer moment magnitude if available)
        magnitude,
        magnitude_type,
        COALESCE(magnitude_error, 0.0) AS magnitude_error,

        -- Magnitude classification (USGS scale)
        CASE
            WHEN magnitude < 2.0 THEN 'MICRO'
            WHEN magnitude < 4.0 THEN 'MINOR'
            WHEN magnitude < 5.0 THEN 'LIGHT'
            WHEN magnitude < 6.0 THEN 'MODERATE'
            WHEN magnitude < 7.0 THEN 'STRONG'
            WHEN magnitude < 8.0 THEN 'MAJOR'
            ELSE 'GREAT'
        END AS magnitude_class,

        -- Depth categorization
        CASE
            WHEN depth_km < 70 THEN 'SHALLOW'
            WHEN depth_km < 300 THEN 'INTERMEDIATE'
            ELSE 'DEEP'
        END AS depth_category,

        -- Geographic region based on coordinates
        CASE
            -- Alaska
            WHEN latitude >= 51 AND longitude < -130 THEN 'ALASKA'
            -- Hawaii
            WHEN latitude BETWEEN 18 AND 23 AND longitude BETWEEN -161 AND -154 THEN 'HAWAII'
            -- Pacific Northwest (Cascadia)
            WHEN latitude BETWEEN 42 AND 49 AND longitude BETWEEN -125 AND -119 THEN 'CASCADIA'
            -- California (San Andreas system)
            WHEN latitude BETWEEN 32 AND 42 AND longitude BETWEEN -125 AND -114 THEN 'CALIFORNIA'
            -- Intermountain West (Basin & Range, Yellowstone)
            WHEN latitude BETWEEN 35 AND 49 AND longitude BETWEEN -119 AND -104 THEN 'INTERMOUNTAIN'
            -- Central US (New Madrid, Oklahoma)
            WHEN latitude BETWEEN 30 AND 42 AND longitude BETWEEN -104 AND -85 THEN 'CENTRAL_US'
            -- Eastern US (including New England)
            WHEN latitude BETWEEN 25 AND 50 AND longitude BETWEEN -85 AND -66 THEN 'EASTERN_US'
            -- Puerto Rico / Caribbean
            WHEN latitude BETWEEN 17 AND 20 AND longitude BETWEEN -68 AND -64 THEN 'CARIBBEAN'
            -- Global / Other
            ELSE 'OTHER'
        END AS seismic_region,

        -- Tectonic setting inference
        CASE
            WHEN latitude >= 51 AND longitude < -130 THEN 'SUBDUCTION'
            WHEN latitude BETWEEN 18 AND 23 AND longitude BETWEEN -161 AND -154 THEN 'HOTSPOT'
            WHEN latitude BETWEEN 32 AND 42 AND longitude BETWEEN -125 AND -114 THEN 'TRANSFORM'
            WHEN latitude BETWEEN 42 AND 49 AND longitude BETWEEN -125 AND -119 THEN 'SUBDUCTION'
            WHEN latitude BETWEEN 35 AND 49 AND longitude BETWEEN -119 AND -104 THEN 'EXTENSIONAL'
            ELSE 'INTRAPLATE'
        END AS tectonic_setting,

        -- Place description
        place_description,

        -- Hazard indicators
        tsunami_flag,
        COALESCE(felt_reports, 0) AS felt_reports,

        -- Intensity
        COALESCE(cdi, 0) AS cdi,
        COALESCE(mmi,
            -- Estimate MMI from magnitude and depth if not directly measured
            -- Simplified Worden et al. (2012) attenuation
            CASE
                WHEN magnitude >= 3.0 AND depth_km < 100
                THEN ROUND(LEAST(12, GREATEST(1,
                    2.0 * magnitude - 1.0 - 1.0 * LOG10(GREATEST(depth_km, 1))
                )), 1)
                ELSE 0
            END
        ) AS mmi_estimated,

        alert_level,
        status,

        -- Quality metrics
        num_stations,
        azimuthal_gap,
        rms,
        horizontal_error,
        depth_error,
        network,
        significance_score,

        -- Is this event part of an aftershock sequence?
        -- Simplified: events within configured space-time window of a larger event
        CASE
            WHEN EXISTS (
                SELECT 1 FROM {{ ref('brz_earthquake_events') }} prior
                WHERE prior.is_valid_record = TRUE
                  AND prior.magnitude >= base.magnitude + 1.0
                  AND prior.event_time < base.event_time
                  AND prior.event_time > base.event_time - INTERVAL '{{ var("aftershock_time_days") }}' DAY
                  AND ABS(prior.latitude - base.latitude) < 0.5
                  AND ABS(prior.longitude - base.longitude) < 0.5
            ) THEN TRUE
            ELSE FALSE
        END AS is_potential_aftershock,

        -- Time-based features for analytics
        YEAR(event_time) AS event_year,
        MONTH(event_time) AS event_month,
        DAYOFWEEK(event_time) AS event_day_of_week,
        HOUR(event_time) AS event_hour_utc,

        -- Time since previous event in same region (for clustering analysis)
        LAG(event_time) OVER (
            PARTITION BY
                CASE
                    WHEN latitude BETWEEN 32 AND 42 AND longitude BETWEEN -125 AND -114 THEN 'CALIFORNIA'
                    WHEN latitude >= 51 AND longitude < -130 THEN 'ALASKA'
                    ELSE 'OTHER'
                END
            ORDER BY event_time
        ) AS prev_event_time_in_region,

        -- Data quality
        CASE
            WHEN magnitude < {{ var('min_magnitude_analysis') }} THEN FALSE
            WHEN num_stations IS NOT NULL AND num_stations < 4 THEN FALSE
            WHEN azimuthal_gap IS NOT NULL AND azimuthal_gap > 300 THEN FALSE
            ELSE TRUE
        END AS is_valid,

        CASE
            WHEN magnitude < {{ var('min_magnitude_analysis') }} THEN 'Below completeness magnitude'
            WHEN num_stations IS NOT NULL AND num_stations < 4 THEN 'Too few stations (< 4)'
            WHEN azimuthal_gap IS NOT NULL AND azimuthal_gap > 300 THEN 'Large azimuthal gap (> 300°)'
            ELSE NULL
        END AS validation_errors,

        -- Metadata
        ingestion_mode,
        'USGS_COMCAT' AS source_system,
        load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM classified
WHERE is_valid = TRUE
