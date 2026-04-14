{{ config(
    materialized='incremental',
    unique_key=['state_fips_code', 'county_code', 'commodity_desc', 'year', 'data_item'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'nass', 'crop_yields']
) }}

WITH source_data AS (
    SELECT
        -- Source identification
        'NASS_QUICKSTATS' as source_system,
        CURRENT_TIMESTAMP() as ingestion_timestamp,

        -- Geographic identifiers
        CASE
            WHEN state_fips_code IS NULL THEN '99'  -- Unknown
            ELSE LPAD(state_fips_code, 2, '0')
        END as state_fips_code,

        CASE
            WHEN county_code IS NULL THEN '999'  -- State-level aggregation
            ELSE LPAD(county_code, 3, '0')
        END as county_code,

        state_alpha as state_code,
        state_name,
        county_name,

        -- Time dimension
        CAST(year as INT) as year,
        reference_period_desc,

        -- Agricultural data
        commodity_desc,
        class_desc,
        prodn_practice_desc,
        util_practice_desc,
        statisticcat_desc,
        data_item,
        domain_desc,

        -- Measurements
        CAST(REPLACE(REPLACE(value, ',', ''), ' ', '') as STRING) as value,
        unit_desc,

        -- Quality indicators
        CASE
            WHEN cv_pct ~ '^[0-9]+\.?[0-9]*$' THEN CAST(cv_pct as DECIMAL(5,2))
            ELSE NULL
        END as cv_pct,

        -- Metadata
        load_time,
        freq_desc,
        begin_code,
        end_code,
        group_desc,
        short_desc,
        sector_desc,

        -- Data quality flags
        CASE
            WHEN value IS NULL OR TRIM(value) = '' THEN FALSE
            WHEN value IN ('(D)', '(Z)', '(L)', '(H)', '(X)', '(S)') THEN FALSE
            WHEN year IS NULL OR year < 1900 OR year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN state_fips_code IS NULL THEN FALSE
            ELSE TRUE
        END as is_valid_record,

        CASE
            WHEN value IN ('(D)', '(Z)', '(L)', '(H)', '(X)', '(S)')
            THEN CONCAT('Suppressed value: ', value)
            WHEN value IS NULL OR TRIM(value) = ''
            THEN 'Missing value'
            WHEN year IS NULL OR year < 1900 OR year > YEAR(CURRENT_DATE()) + 1
            THEN 'Invalid year'
            WHEN state_fips_code IS NULL
            THEN 'Missing state code'
            ELSE NULL
        END as validation_errors,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) as raw_json,

        -- Processing metadata
        MD5(CONCAT_WS('|',
            COALESCE(state_fips_code, ''),
            COALESCE(county_code, ''),
            COALESCE(commodity_desc, ''),
            COALESCE(CAST(year as STRING), ''),
            COALESCE(data_item, '')
        )) as record_hash,

        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM {{ source('usda', 'nass_crop_yields') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    -- Basic data quality filters
    AND year IS NOT NULL
    AND state_fips_code IS NOT NULL
    AND commodity_desc IS NOT NULL