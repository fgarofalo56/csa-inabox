{{ config(
    materialized='incremental',
    unique_key=['encounter_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'encounters', 'clinical', 'hipaa']
) }}

/*
    Bronze Layer — Raw Clinical Encounter Records (Synthetic)

    Source: Synthetic RPMS-compatible encounter extract.
    FHIR Mapping: Encounter resource (identifier, subject, period, type,
                  diagnosis, serviceProvider)

    Captures inpatient, outpatient, ED, and telehealth encounters with
    ICD-10 diagnosis codes, provider types, and disposition.

    All data is ENTIRELY SYNTHETIC. No real patient encounters.
*/

WITH source_data AS (
    SELECT
        -- Source identification
        'SYNTHETIC_RPMS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Encounter identifiers
        CAST(encounter_id AS STRING) AS encounter_id,
        CAST(patient_id AS STRING) AS patient_id,
        CAST(facility_id AS STRING) AS facility_id,

        -- Encounter timing
        CAST(encounter_date AS DATE) AS encounter_date,

        -- Encounter classification
        UPPER(TRIM(encounter_type)) AS encounter_type,

        -- Diagnosis codes (ICD-10-CM)
        UPPER(TRIM(primary_dx_icd10)) AS primary_dx_icd10,

        -- Secondary diagnoses stored as pipe-delimited string
        CAST(secondary_dx_codes AS STRING) AS secondary_dx_codes,

        -- Provider information
        UPPER(TRIM(provider_type)) AS provider_type,

        -- Encounter outcome
        UPPER(TRIM(disposition)) AS disposition,

        -- Data quality flags
        CASE
            WHEN encounter_id IS NULL THEN FALSE
            WHEN patient_id IS NULL THEN FALSE
            WHEN facility_id IS NULL THEN FALSE
            WHEN encounter_date IS NULL THEN FALSE
            WHEN encounter_type IS NULL THEN FALSE
            WHEN encounter_type NOT IN ('INPATIENT', 'OUTPATIENT', 'ED', 'TELEHEALTH') THEN FALSE
            WHEN encounter_date > CURRENT_DATE() THEN FALSE
            WHEN primary_dx_icd10 IS NULL OR TRIM(primary_dx_icd10) = '' THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN encounter_id IS NULL THEN 'Missing encounter_id'
            WHEN patient_id IS NULL THEN 'Missing patient_id'
            WHEN facility_id IS NULL THEN 'Missing facility_id'
            WHEN encounter_date IS NULL THEN 'Missing encounter_date'
            WHEN encounter_type IS NULL THEN 'Missing encounter_type'
            WHEN encounter_type NOT IN ('INPATIENT', 'OUTPATIENT', 'ED', 'TELEHEALTH') THEN 'Invalid encounter_type'
            WHEN encounter_date > CURRENT_DATE() THEN 'Future encounter_date'
            WHEN primary_dx_icd10 IS NULL OR TRIM(primary_dx_icd10) = '' THEN 'Missing primary_dx_icd10'
            ELSE NULL
        END AS validation_errors,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(CAST(encounter_id AS STRING), ''),
            COALESCE(CAST(patient_id AS STRING), ''),
            COALESCE(CAST(facility_id AS STRING), ''),
            COALESCE(CAST(encounter_date AS STRING), ''),
            COALESCE(encounter_type, ''),
            COALESCE(primary_dx_icd10, '')
        )) AS record_hash,

        -- Processing metadata
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('tribal_health', 'encounters') }}

    {% if is_incremental() %}
        WHERE ingestion_timestamp > (SELECT MAX(ingestion_timestamp) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE encounter_id IS NOT NULL
  AND patient_id IS NOT NULL
