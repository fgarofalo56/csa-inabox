{{ config(
    materialized='incremental',
    unique_key=['establishment_number', 'inspection_date', 'inspection_type'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'fsis', 'food_inspections'],
    on_schema_change='fail'
) }}

WITH source_data AS (
    SELECT
        -- Source identification
        'FSIS_INSPECTION' as source_system,
        CURRENT_TIMESTAMP() as ingestion_timestamp,

        -- Establishment identifiers
        TRIM(establishment_number) as establishment_number,
        TRIM(establishment_name) as establishment_name,
        TRIM(company_name) as company_name,

        -- Geographic identifiers
        UPPER(TRIM(state)) as state_code,
        TRIM(city) as city,
        TRIM(zip_code) as zip_code,

        -- Inspection details
        CASE
            WHEN inspection_date IS NOT NULL
            THEN TRY_CAST(inspection_date as DATE)
            ELSE NULL
        END as inspection_date,

        TRIM(inspection_type) as inspection_type,
        TRIM(inspection_disposition) as inspection_disposition,

        -- Violation details
        TRIM(violation_type) as violation_type,
        TRIM(violation_description) as violation_description,
        TRIM(violation_severity) as violation_severity,

        CASE
            WHEN citation_number ~ '^[0-9]+$'
            THEN CAST(citation_number as INT)
            ELSE NULL
        END as citation_number,

        -- Regulatory information
        TRIM(regulation_cited) as regulation_cited,
        TRIM(corrective_action) as corrective_action,

        CASE
            WHEN corrective_action_date IS NOT NULL
            THEN TRY_CAST(corrective_action_date as DATE)
            ELSE NULL
        END as corrective_action_date,

        -- Establishment characteristics
        TRIM(establishment_type) as establishment_type,
        TRIM(species) as species,
        TRIM(process_category) as process_category,

        CASE
            WHEN employee_count ~ '^[0-9]+$'
            THEN CAST(employee_count as INT)
            ELSE NULL
        END as employee_count,

        -- Inspection outcomes
        CASE
            WHEN UPPER(TRIM(compliance_status)) IN ('COMPLIANT', 'NON-COMPLIANT', 'PENDING')
            THEN UPPER(TRIM(compliance_status))
            ELSE 'UNKNOWN'
        END as compliance_status,

        CASE
            WHEN inspection_score ~ '^[0-9]+\.?[0-9]*$'
            THEN CAST(inspection_score as DECIMAL(5,2))
            ELSE NULL
        END as inspection_score,

        -- Data quality flags
        CASE
            WHEN establishment_number IS NULL OR TRIM(establishment_number) = '' THEN FALSE
            WHEN inspection_date IS NULL THEN FALSE
            WHEN inspection_type IS NULL OR TRIM(inspection_type) = '' THEN FALSE
            WHEN state IS NULL OR TRIM(state) = '' THEN FALSE
            ELSE TRUE
        END as is_valid_record,

        CASE
            WHEN establishment_number IS NULL OR TRIM(establishment_number) = ''
            THEN 'Missing establishment number'
            WHEN inspection_date IS NULL
            THEN 'Missing inspection date'
            WHEN inspection_type IS NULL OR TRIM(inspection_type) = ''
            THEN 'Missing inspection type'
            WHEN state IS NULL OR TRIM(state) = ''
            THEN 'Missing state'
            ELSE NULL
        END as validation_errors,

        -- Metadata
        report_period,
        data_last_updated,
        inspector_id,
        inspection_duration_hours,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) as raw_json,

        -- Processing metadata
        MD5(CONCAT_WS('|',
            COALESCE(establishment_number, ''),
            COALESCE(CAST(inspection_date as STRING), ''),
            COALESCE(inspection_type, ''),
            COALESCE(violation_type, ''),
            COALESCE(CAST(citation_number as STRING), '')
        )) as record_hash,

        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM {{ source('usda', 'fsis_inspections') }}

    {% if is_incremental() %}
        WHERE data_last_updated > (SELECT MAX(data_last_updated) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    -- Basic data quality filters
    AND establishment_number IS NOT NULL
    AND inspection_date IS NOT NULL
    AND inspection_type IS NOT NULL