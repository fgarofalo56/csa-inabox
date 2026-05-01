-- ==========================================================================
-- Staging Model: Raw Patient Demographics
-- Source: Bronze layer - EHR/FHIR patient records (de-identified)
-- Note: All data is synthetic. No real PHI. Age represented as age_group,
--       ZIP truncated to 3-digit prefix per HIPAA Safe Harbor.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='patient_id',
    schema='bronze'
) }}

SELECT
    patient_id                                      AS patient_id,
    CAST(age_group AS STRING)                       AS age_group,
    CAST(gender AS STRING)                          AS gender,
    CAST(zip_3 AS STRING)                           AS zip_3,
    CAST(race_ethnicity AS STRING)                  AS race_ethnicity,
    CAST(primary_language AS STRING)                AS primary_language,
    CAST(insurance_type AS STRING)                  AS insurance_type,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('clinical_raw', 'raw_patients') }}

{% if is_incremental() %}
WHERE patient_id NOT IN (
    SELECT patient_id FROM {{ this }}
)
{% endif %}
