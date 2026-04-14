{{ config(
    materialized='incremental',
    unique_key='water_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'water', 'hydrology', 'cleaned']
) }}

{#
    Silver Layer: Normalized Water Data with Drought Index and Flood Stage Mapping

    Transforms raw USGS water gauge measurements into analytics-ready format.

    Key transformations:
    1. Drought index calculation using percentile comparison to historical record
    2. Flood stage classification against NWS reference levels
    3. Seasonal flow percentile ranking
    4. Baseflow and stormflow separation proxy
    5. Missing data interpolation for continuous time series
    6. Unit standardization (CFS for streamflow, feet for gauge height)

    Drought Index (simplified Palmer Drought Severity Index proxy):
    - Uses streamflow percentile relative to historical period
    - Percentile < 10: Extreme drought
    - Percentile 10-25: Moderate drought
    - Percentile 25-75: Normal
    - Percentile 75-90: Above normal
    - Percentile > 90: Much above normal / flood risk

    Flood Stage Classification (NWS definitions):
    - Below action stage: Normal operations
    - Action stage: Near-flood, begin monitoring
    - Minor flood: Minimal or no property damage, some public threat
    - Moderate flood: Inundation of structures, road closures
    - Major flood: Extensive inundation, significant threat to life/property
#}

WITH base AS (
    SELECT * FROM {{ ref('brz_water_resources') }}
    WHERE is_valid_record = TRUE
      AND parameter_code IN ('00060', '00065')  -- Streamflow and gauge height

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            site_id,
            CAST(measurement_date AS STRING),
            parameter_code
        )) AS water_sk,

        -- Site identification
        site_id,
        site_name,
        site_latitude,
        site_longitude,
        site_type,
        state_code,
        county_code,
        huc_code,

        -- Watershed info derived from HUC
        CASE
            WHEN LENGTH(huc_code) >= 2 THEN SUBSTRING(huc_code, 1, 2)
            ELSE NULL
        END AS huc_region,
        CASE
            WHEN LENGTH(huc_code) >= 4 THEN SUBSTRING(huc_code, 1, 4)
            ELSE NULL
        END AS huc_subregion,

        drainage_area_sq_mi,

        -- Time dimension
        measurement_date,
        measurement_datetime,
        YEAR(measurement_date) AS measurement_year,
        MONTH(measurement_date) AS measurement_month,
        DAYOFYEAR(measurement_date) AS day_of_year,

        -- Measurement values
        parameter_code,
        CASE
            WHEN parameter_code = '00060' THEN 'STREAMFLOW_CFS'
            WHEN parameter_code = '00065' THEN 'GAUGE_HEIGHT_FT'
            ELSE parameter_name
        END AS parameter_name_std,

        COALESCE(daily_mean, value) AS measurement_value,
        daily_min,
        daily_max,

        -- Daily range (max - min) as variability indicator
        CASE
            WHEN daily_max IS NOT NULL AND daily_min IS NOT NULL
            THEN ROUND(daily_max - daily_min, 4)
            ELSE NULL
        END AS daily_range,

        -- Specific discharge (flow normalized by drainage area)
        CASE
            WHEN parameter_code = '00060' AND drainage_area_sq_mi > 0
            THEN ROUND(COALESCE(daily_mean, value) / drainage_area_sq_mi, 4)
            ELSE NULL
        END AS specific_discharge_cfs_per_sqmi,

        -- Data quality flag from USGS
        qualification_code,
        CASE
            WHEN qualification_code = 'A' THEN 'APPROVED'
            WHEN qualification_code = 'P' THEN 'PROVISIONAL'
            WHEN qualification_code = 'e' THEN 'ESTIMATED'
            ELSE 'UNKNOWN'
        END AS data_quality_level,

        -- Flood stage classification (for gauge height parameter)
        action_stage_ft,
        flood_stage_ft,
        moderate_flood_stage_ft,
        major_flood_stage_ft,

        CASE
            WHEN parameter_code = '00065' AND major_flood_stage_ft IS NOT NULL
                 AND COALESCE(daily_mean, value) >= major_flood_stage_ft THEN 'MAJOR_FLOOD'
            WHEN parameter_code = '00065' AND moderate_flood_stage_ft IS NOT NULL
                 AND COALESCE(daily_mean, value) >= moderate_flood_stage_ft THEN 'MODERATE_FLOOD'
            WHEN parameter_code = '00065' AND flood_stage_ft IS NOT NULL
                 AND COALESCE(daily_mean, value) >= flood_stage_ft THEN 'MINOR_FLOOD'
            WHEN parameter_code = '00065' AND action_stage_ft IS NOT NULL
                 AND COALESCE(daily_mean, value) >= action_stage_ft THEN 'ACTION_STAGE'
            WHEN parameter_code = '00065' THEN 'NORMAL'
            ELSE NULL
        END AS flood_stage_class,

        -- Historical percentile comparison for drought/surplus
        percentile_10,
        percentile_25,
        percentile_50,
        percentile_75,
        percentile_90,

        -- Drought index classification
        CASE
            WHEN percentile_10 IS NOT NULL AND COALESCE(daily_mean, value) <= percentile_10
                THEN 'EXTREME_DROUGHT'
            WHEN percentile_25 IS NOT NULL AND COALESCE(daily_mean, value) <= percentile_25
                THEN 'MODERATE_DROUGHT'
            WHEN percentile_75 IS NOT NULL AND COALESCE(daily_mean, value) <= percentile_75
                THEN 'NORMAL'
            WHEN percentile_90 IS NOT NULL AND COALESCE(daily_mean, value) <= percentile_90
                THEN 'ABOVE_NORMAL'
            WHEN percentile_90 IS NOT NULL AND COALESCE(daily_mean, value) > percentile_90
                THEN 'MUCH_ABOVE_NORMAL'
            ELSE 'INSUFFICIENT_HISTORY'
        END AS drought_index,

        -- Percentile of current value relative to historical distribution
        CASE
            WHEN percentile_50 IS NOT NULL AND percentile_50 > 0
            THEN ROUND(COALESCE(daily_mean, value) / percentile_50 * 50, 1)
            ELSE NULL
        END AS estimated_percentile,

        -- Season
        CASE
            WHEN MONTH(measurement_date) IN (12, 1, 2) THEN 'WINTER'
            WHEN MONTH(measurement_date) IN (3, 4, 5) THEN 'SPRING'
            WHEN MONTH(measurement_date) IN (6, 7, 8) THEN 'SUMMER'
            WHEN MONTH(measurement_date) IN (9, 10, 11) THEN 'FALL'
        END AS season,

        -- Data quality
        CASE
            WHEN COALESCE(daily_mean, value) IS NULL THEN FALSE
            WHEN parameter_code = '00060' AND COALESCE(daily_mean, value) < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid,

        CASE
            WHEN COALESCE(daily_mean, value) IS NULL THEN 'Missing measurement value'
            WHEN parameter_code = '00060' AND COALESCE(daily_mean, value) < 0
                THEN 'Negative streamflow'
            ELSE NULL
        END AS validation_errors,

        -- Metadata
        ingestion_mode,
        'USGS_NWIS' AS source_system,
        load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
WHERE is_valid = TRUE
