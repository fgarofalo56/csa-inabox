{{ config(
    materialized='incremental',
    unique_key=['facility_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'facilities', 'reference', 'hipaa']
) }}

/*
    Bronze Layer — IHS / Tribal / Urban Indian Health Facilities

    Source: IHS facility reference data combined with synthetic operational metrics.
    FHIR Mapping: Organization resource (identifier, name, type, address,
                  extension:serviceUnit)

    Covers IHS hospitals, health centers, and satellite clinics with
    staffing, capacity, and services offered.
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'IHS_FACILITY_REF' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Facility identifiers
        CAST(facility_id AS STRING) AS facility_id,
        TRIM(facility_name) AS facility_name,

        -- Facility classification
        UPPER(TRIM(facility_type)) AS facility_type,

        -- Organizational hierarchy
        UPPER(TRIM(service_unit)) AS service_unit,
        UPPER(TRIM(tribal_affiliation)) AS tribal_affiliation,
        UPPER(TRIM(state)) AS state,

        -- Capacity metrics
        CAST(bed_count AS INT) AS bed_count,
        CAST(provider_count AS INT) AS provider_count,

        -- Services offered (pipe-delimited list)
        CAST(services_offered AS STRING) AS services_offered,

        -- Data quality flags
        CASE
            WHEN facility_id IS NULL THEN FALSE
            WHEN facility_name IS NULL OR TRIM(facility_name) = '' THEN FALSE
            WHEN facility_type IS NULL THEN FALSE
            WHEN facility_type NOT IN ('HOSPITAL', 'HEALTH_CENTER', 'SATELLITE') THEN FALSE
            WHEN service_unit IS NULL OR TRIM(service_unit) = '' THEN FALSE
            WHEN state IS NULL OR LENGTH(TRIM(state)) != 2 THEN FALSE
            WHEN bed_count IS NOT NULL AND bed_count < 0 THEN FALSE
            WHEN provider_count IS NOT NULL AND provider_count < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN facility_id IS NULL THEN 'Missing facility_id'
            WHEN facility_name IS NULL OR TRIM(facility_name) = '' THEN 'Missing facility_name'
            WHEN facility_type IS NULL THEN 'Missing facility_type'
            WHEN facility_type NOT IN ('HOSPITAL', 'HEALTH_CENTER', 'SATELLITE') THEN 'Invalid facility_type'
            WHEN service_unit IS NULL OR TRIM(service_unit) = '' THEN 'Missing service_unit'
            WHEN state IS NULL OR LENGTH(TRIM(state)) != 2 THEN 'Invalid state code'
            WHEN bed_count IS NOT NULL AND bed_count < 0 THEN 'Negative bed_count'
            WHEN provider_count IS NOT NULL AND provider_count < 0 THEN 'Negative provider_count'
            ELSE NULL
        END AS validation_errors,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(facility_id AS STRING), ''),
            COALESCE(facility_name, ''),
            COALESCE(facility_type, ''),
            COALESCE(service_unit, ''),
            COALESCE(state, '')
        )) AS record_hash,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('tribal_health', 'facilities') }}

    {% if is_incremental() %}
        WHERE ingestion_timestamp > (SELECT MAX(ingestion_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE facility_id IS NOT NULL
