{{ config(
    materialized='incremental',
    unique_key=['geo_id', 'variable_code', 'year', 'dataset'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'census', 'demographics']
) }}

{#
    Bronze Layer: Census Bureau ACS Demographic and Economic Data

    Source: Census API (api.census.gov)
    Datasets: American Community Survey 1-year (acs1) and 5-year (acs5) estimates
    Granularity: Census tract, county, and state level

    Key variables ingested:
    - B01001: Total population by age/sex
    - B19013: Median household income
    - B15003: Educational attainment
    - B23025: Employment status
    - B17001: Poverty status
    - B25001: Housing units

    This model preserves raw API responses with minimal transformation,
    adding source tracking and basic validation flags.
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'CENSUS_ACS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Geographic identifiers (Census GEOID decomposition)
        geo_id,
        CASE
            WHEN LENGTH(geo_id) >= 2 THEN LPAD(SUBSTRING(geo_id, 1, 2), 2, '0')
            ELSE '99'
        END AS state_fips,
        CASE
            WHEN LENGTH(geo_id) >= 5 THEN SUBSTRING(geo_id, 3, 3)
            ELSE '000'
        END AS county_fips,
        CASE
            WHEN LENGTH(geo_id) >= 11 THEN SUBSTRING(geo_id, 6, 6)
            ELSE NULL
        END AS tract_code,

        state_name,
        county_name,

        -- Time dimension
        CAST(year AS INT) AS year,
        dataset,  -- 'acs1', 'acs5', 'decennial'

        -- Census variable data
        variable_code,
        variable_name,
        variable_concept,

        -- Measurement values
        CAST(estimate AS DECIMAL(18, 2)) AS estimate,
        CAST(margin_of_error AS DECIMAL(18, 2)) AS margin_of_error,

        -- Calculated CV (coefficient of variation) from MOE
        -- MOE at 90% confidence: CV = (MOE / 1.645) / estimate * 100
        CASE
            WHEN estimate IS NOT NULL AND estimate != 0 AND margin_of_error IS NOT NULL
            THEN ROUND(ABS(margin_of_error / 1.645) / ABS(estimate) * 100, 2)
            ELSE NULL
        END AS coefficient_of_variation,

        -- Quality indicators
        CASE
            WHEN estimate IS NULL AND margin_of_error IS NULL THEN FALSE
            WHEN geo_id IS NULL OR LENGTH(geo_id) < 2 THEN FALSE
            WHEN year IS NULL OR year < 2000 OR year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN variable_code IS NULL THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN estimate IS NULL AND margin_of_error IS NULL THEN 'Missing estimate and MOE'
            WHEN geo_id IS NULL OR LENGTH(geo_id) < 2 THEN 'Invalid geography'
            WHEN year IS NULL OR year < 2000 THEN 'Invalid year'
            WHEN variable_code IS NULL THEN 'Missing variable code'
            ELSE NULL
        END AS validation_errors,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Processing metadata
        MD5(CONCAT_WS('|',
            COALESCE(geo_id, ''),
            COALESCE(variable_code, ''),
            COALESCE(CAST(year AS STRING), ''),
            COALESCE(dataset, '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('commerce', 'census_demographics') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    -- Basic data quality filters
    AND year IS NOT NULL
    AND geo_id IS NOT NULL
    AND variable_code IS NOT NULL
