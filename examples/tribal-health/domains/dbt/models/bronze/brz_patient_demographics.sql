{{ config(
    materialized='incremental',
    unique_key=['patient_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'patient', 'demographics', 'hipaa']
) }}

/*
    Bronze Layer — Raw Patient Demographics (Synthetic)

    Source: Synthetic RPMS-compatible patient demographic extract.
    FHIR Mapping: Patient resource (identifier, birthDate as age_group, gender,
                  extension:tribalAffiliation)

    All data is ENTIRELY SYNTHETIC. No real patient data.
    De-identification: Uses random patient_id, age_group (not DOB), no names.
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'SYNTHETIC_RPMS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Patient identifiers (synthetic random IDs — not real MRNs)
        CAST(patient_id AS STRING) AS patient_id,

        -- Tribal affiliation (maps to FHIR extension:tribalAffiliation)
        UPPER(TRIM(tribal_affiliation)) AS tribal_affiliation,

        -- IHS service unit assignment
        UPPER(TRIM(service_unit)) AS service_unit,

        -- Demographics (age_group used instead of DOB for de-identification)
        CAST(age_group AS STRING) AS age_group,
        UPPER(TRIM(gender)) AS gender,

        -- Geographic (zip code for area-level analysis, not street address)
        LPAD(CAST(zip_code AS STRING), 5, '0') AS zip_code,

        -- Enrollment information
        CAST(enrollment_date AS DATE) AS enrollment_date,
        UPPER(TRIM(eligibility_status)) AS eligibility_status,

        -- Data quality flags
        CASE
            WHEN patient_id IS NULL THEN FALSE
            WHEN tribal_affiliation IS NULL OR TRIM(tribal_affiliation) = '' THEN FALSE
            WHEN service_unit IS NULL OR TRIM(service_unit) = '' THEN FALSE
            WHEN age_group IS NULL THEN FALSE
            WHEN gender IS NULL THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN patient_id IS NULL THEN 'Missing patient_id'
            WHEN tribal_affiliation IS NULL OR TRIM(tribal_affiliation) = '' THEN 'Missing tribal_affiliation'
            WHEN service_unit IS NULL OR TRIM(service_unit) = '' THEN 'Missing service_unit'
            WHEN age_group IS NULL THEN 'Missing age_group'
            WHEN gender IS NULL THEN 'Missing gender'
            ELSE NULL
        END AS validation_errors,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(patient_id AS STRING), ''),
            COALESCE(tribal_affiliation, ''),
            COALESCE(service_unit, ''),
            COALESCE(CAST(age_group AS STRING), ''),
            COALESCE(gender, ''),
            COALESCE(CAST(zip_code AS STRING), ''),
            COALESCE(CAST(enrollment_date AS STRING), ''),
            COALESCE(eligibility_status, '')
        )) AS record_hash,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('tribal_health', 'patient_demographics') }}

    {% if is_incremental() %}
        WHERE ingestion_timestamp > (SELECT MAX(ingestion_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE patient_id IS NOT NULL
