{{ config(
    materialized='incremental',
    unique_key=['state_code', 'month_year', 'program'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'fns', 'snap_enrollment']
) }}

WITH source_data AS (
    SELECT
        -- Source identification
        'FNS_SNAP' as source_system,
        CURRENT_TIMESTAMP() as ingestion_timestamp,

        -- Geographic identifiers
        UPPER(TRIM(state)) as state_code,
        state_name,
        CASE
            WHEN county_fips IS NOT NULL THEN LPAD(CAST(county_fips as STRING), 5, '0')
            ELSE NULL
        END as county_fips,
        county_name,

        -- Time dimension
        CAST(fiscal_year as INT) as fiscal_year,
        CAST(month_number as INT) as month_number,
        month_name,
        CONCAT(CAST(fiscal_year as STRING), '-', LPAD(CAST(month_number as STRING), 2, '0')) as month_year,

        -- Program information
        COALESCE(program, 'SNAP') as program,
        program_type,

        -- Enrollment metrics
        CASE
            WHEN persons ~ '^[0-9]+$' THEN CAST(persons as BIGINT)
            ELSE NULL
        END as persons,

        CASE
            WHEN households ~ '^[0-9]+$' THEN CAST(households as BIGINT)
            ELSE NULL
        END as households,

        CASE
            WHEN benefits ~ '^[0-9]+\.?[0-9]*$'
            THEN CAST(REPLACE(benefits, ',', '') as DECIMAL(18,2))
            ELSE NULL
        END as benefits_dollars,

        CASE
            WHEN issuance ~ '^[0-9]+\.?[0-9]*$'
            THEN CAST(REPLACE(issuance, ',', '') as DECIMAL(18,2))
            ELSE NULL
        END as issuance_dollars,

        -- Participation rates (if available)
        CASE
            WHEN participation_rate ~ '^[0-9]+\.?[0-9]*$'
            THEN CAST(participation_rate as DECIMAL(5,2))
            ELSE NULL
        END as participation_rate,

        -- Data quality flags
        CASE
            WHEN state IS NULL OR TRIM(state) = '' THEN FALSE
            WHEN fiscal_year IS NULL OR fiscal_year < 2000 OR fiscal_year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN month_number IS NULL OR month_number < 1 OR month_number > 12 THEN FALSE
            WHEN persons IS NULL AND households IS NULL AND benefits IS NULL THEN FALSE
            ELSE TRUE
        END as is_valid_record,

        CASE
            WHEN state IS NULL OR TRIM(state) = ''
            THEN 'Missing state'
            WHEN fiscal_year IS NULL OR fiscal_year < 2000 OR fiscal_year > YEAR(CURRENT_DATE()) + 1
            THEN 'Invalid fiscal year'
            WHEN month_number IS NULL OR month_number < 1 OR month_number > 12
            THEN 'Invalid month'
            WHEN persons IS NULL AND households IS NULL AND benefits IS NULL
            THEN 'No enrollment data'
            ELSE NULL
        END as validation_errors,

        -- Metadata
        report_date,
        data_as_of_date,
        footnotes,
        COALESCE(confidentiality_flag, 'N') as confidentiality_flag,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) as raw_json,

        -- Processing metadata
        MD5(CONCAT_WS('|',
            COALESCE(state, ''),
            COALESCE(CAST(fiscal_year as STRING), ''),
            COALESCE(CAST(month_number as STRING), ''),
            COALESCE(program, ''),
            COALESCE(county_fips, '')
        )) as record_hash,

        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM {{ source('usda', 'snap_enrollment') }}

    {% if is_incremental() %}
        WHERE report_date > (SELECT MAX(report_date) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    -- Basic data quality filters
    AND fiscal_year IS NOT NULL
    AND month_number IS NOT NULL
    AND state_code IS NOT NULL