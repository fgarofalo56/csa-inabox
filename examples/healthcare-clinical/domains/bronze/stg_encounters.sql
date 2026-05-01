-- ==========================================================================
-- Staging Model: Raw Encounters
-- Source: Bronze layer - EHR/FHIR encounter and visit records
-- Note: All data is synthetic and fully de-identified (HIPAA Safe Harbor).
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='encounter_id',
    schema='bronze'
) }}

SELECT
    encounter_id                                    AS encounter_id,
    patient_id                                      AS patient_id,
    CAST(admit_date AS DATE)                        AS admit_date,
    CAST(discharge_date AS DATE)                    AS discharge_date,
    CAST(facility AS STRING)                        AS facility,
    CAST(department AS STRING)                      AS department,
    CAST(encounter_type AS STRING)                  AS encounter_type,
    CAST(discharge_disposition AS STRING)           AS discharge_disposition,
    CAST(payer AS STRING)                           AS payer,
    CAST(drg_code AS STRING)                        AS drg_code,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('clinical_raw', 'raw_encounters') }}

{% if is_incremental() %}
WHERE CAST(discharge_date AS DATE) > (
    SELECT MAX(discharge_date) FROM {{ this }}
)
{% endif %}
