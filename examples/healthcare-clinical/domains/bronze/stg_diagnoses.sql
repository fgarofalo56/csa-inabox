-- ==========================================================================
-- Staging Model: Raw Diagnosis Codes
-- Source: Bronze layer - EHR/Claims diagnosis records
-- Note: All data is synthetic and fully de-identified.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='encounter_id || icd10_code',
    schema='bronze'
) }}

SELECT
    encounter_id                                    AS encounter_id,
    CAST(icd10_code AS STRING)                      AS icd10_code,
    CAST(diagnosis_type AS STRING)                  AS diagnosis_type,
    CAST(sequence AS INT)                           AS sequence,
    CAST(description AS STRING)                     AS description,
    CAST(present_on_admit AS STRING)                AS present_on_admit,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('clinical_raw', 'raw_diagnoses') }}

{% if is_incremental() %}
WHERE encounter_id IN (
    SELECT encounter_id
    FROM {{ ref('stg_encounters') }}
    WHERE ingested_at > (
        SELECT COALESCE(MAX(ingested_at), '1900-01-01') FROM {{ this }}
    )
)
{% endif %}
