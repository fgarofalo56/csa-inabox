{{ config(
    materialized='incremental',
    unique_key='patient_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'patient', 'demographics', 'hipaa', 'data_sovereignty'],
    on_schema_change='fail'
) }}

/*
    Silver Layer — Cleaned Patient Demographics

    Transforms raw synthetic patient demographics with:
    - Age band calculation from age_group for aggregate reporting
    - Enrollment status validation and standardization
    - De-identification flags for HIPAA Safe Harbor compliance
    - Tribal affiliation standardization for RLS enforcement

    Row-Level Security: This table is filtered by tribal_affiliation
    via Databricks Unity Catalog RLS policies.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_patient_demographics') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            patient_id,
            COALESCE(tribal_affiliation, ''),
            COALESCE(service_unit, '')
        )) AS patient_sk,

        -- Patient identifier (synthetic — not a real MRN)
        patient_id,

        -- Tribal affiliation (standardized for RLS)
        tribal_affiliation,

        -- IHS service unit
        service_unit,

        -- Age band for aggregate reporting (not exact age)
        age_group,
        CASE
            WHEN age_group IN ('0-4', '5-9', '10-14') THEN 'PEDIATRIC'
            WHEN age_group IN ('15-19') THEN 'ADOLESCENT'
            WHEN age_group IN ('20-24', '25-29', '30-34', '35-39', '40-44') THEN 'ADULT'
            WHEN age_group IN ('45-49', '50-54', '55-59', '60-64') THEN 'MIDDLE_AGED'
            WHEN age_group IN ('65-69', '70-74', '75-79', '80+') THEN 'ELDER'
            ELSE 'UNKNOWN'
        END AS age_band,

        -- Gender standardization
        CASE
            WHEN gender IN ('M', 'MALE') THEN 'M'
            WHEN gender IN ('F', 'FEMALE') THEN 'F'
            WHEN gender IN ('NB', 'NON-BINARY', 'NONBINARY') THEN 'NB'
            ELSE 'U'
        END AS gender,

        -- Geographic
        zip_code,
        LEFT(zip_code, 3) AS zip3,  -- 3-digit ZIP for de-identified reporting

        -- Enrollment
        enrollment_date,
        CASE
            WHEN eligibility_status IN ('ACTIVE', 'ELIGIBLE') THEN 'ACTIVE'
            WHEN eligibility_status IN ('INACTIVE', 'INELIGIBLE', 'TERMINATED') THEN 'INACTIVE'
            WHEN eligibility_status IN ('PENDING', 'PENDING_VERIFICATION') THEN 'PENDING'
            ELSE 'UNKNOWN'
        END AS eligibility_status,

        -- Enrollment duration
        CASE
            WHEN enrollment_date IS NOT NULL
            THEN DATEDIFF(CURRENT_DATE(), enrollment_date)
            ELSE NULL
        END AS enrollment_days,

        -- De-identification flags (HIPAA Safe Harbor method)
        TRUE AS is_deidentified,           -- All synthetic data is considered de-identified
        FALSE AS contains_phi,              -- No PHI in synthetic data
        FALSE AS contains_direct_identifiers, -- No names, SSNs, etc.

        -- Data quality
        CASE
            WHEN age_group IS NOT NULL
                 AND gender IS NOT NULL
                 AND tribal_affiliation IS NOT NULL
                 AND service_unit IS NOT NULL
                 AND eligibility_status IS NOT NULL
            THEN TRUE
            ELSE FALSE
        END AS is_valid,

        -- Metadata
        source_system,
        ingestion_timestamp,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
WHERE is_valid = TRUE
