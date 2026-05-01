-- ==========================================================================
-- Dimension Model: Diagnoses
-- ICD-10 codes enriched with CCS (Clinical Classifications Software)
-- groupings and clinical domain categorization.
-- All data is synthetic — no real PHI.
-- ==========================================================================

{{ config(
    materialized='view',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_diagnoses') }}
),

enriched AS (
    SELECT
        encounter_id,
        icd10_code,
        diagnosis_type,
        sequence,
        description,
        present_on_admit,

        -- Primary vs. secondary flag
        CASE
            WHEN sequence = 1 THEN TRUE
            ELSE FALSE
        END                                         AS is_primary_diagnosis,

        -- ICD-10 chapter / clinical domain derived from code prefix
        CASE
            WHEN icd10_code LIKE 'A%' OR icd10_code LIKE 'B%'
                THEN 'Infectious Disease'
            WHEN icd10_code LIKE 'C%' OR icd10_code LIKE 'D0%' OR icd10_code LIKE 'D1%' OR icd10_code LIKE 'D2%' OR icd10_code LIKE 'D3%' OR icd10_code LIKE 'D4%'
                THEN 'Neoplasms'
            WHEN icd10_code LIKE 'E%'
                THEN 'Endocrine / Metabolic'
            WHEN icd10_code LIKE 'F%'
                THEN 'Mental / Behavioral'
            WHEN icd10_code LIKE 'G%'
                THEN 'Nervous System'
            WHEN icd10_code LIKE 'I%'
                THEN 'Circulatory'
            WHEN icd10_code LIKE 'J%'
                THEN 'Respiratory'
            WHEN icd10_code LIKE 'K%'
                THEN 'Digestive'
            WHEN icd10_code LIKE 'M%'
                THEN 'Musculoskeletal'
            WHEN icd10_code LIKE 'N%'
                THEN 'Genitourinary'
            WHEN icd10_code LIKE 'R%'
                THEN 'Signs / Symptoms'
            WHEN icd10_code LIKE 'S%' OR icd10_code LIKE 'T%'
                THEN 'Injury / Poisoning'
            WHEN icd10_code LIKE 'Z%'
                THEN 'Health Status / Contact'
            ELSE 'Other'
        END                                         AS clinical_domain,

        -- Simplified CCS-like category (representative grouping)
        CASE
            WHEN icd10_code LIKE 'I21%' OR icd10_code LIKE 'I22%'
                THEN 'Acute Myocardial Infarction'
            WHEN icd10_code LIKE 'I50%'
                THEN 'Heart Failure'
            WHEN icd10_code LIKE 'J44%'
                THEN 'COPD'
            WHEN icd10_code LIKE 'J18%' OR icd10_code LIKE 'J15%' OR icd10_code LIKE 'J13%'
                THEN 'Pneumonia'
            WHEN icd10_code LIKE 'E11%'
                THEN 'Type 2 Diabetes'
            WHEN icd10_code LIKE 'N17%' OR icd10_code LIKE 'N18%'
                THEN 'Kidney Disease'
            WHEN icd10_code LIKE 'I63%'
                THEN 'Cerebral Infarction'
            WHEN icd10_code LIKE 'K35%'
                THEN 'Appendicitis'
            WHEN icd10_code LIKE 'S72%'
                THEN 'Hip Fracture'
            WHEN icd10_code LIKE 'Z51%'
                THEN 'Encounter for Other Aftercare'
            ELSE 'Other'
        END                                         AS ccs_category,

        CURRENT_TIMESTAMP()                         AS updated_at

    FROM staged
)

SELECT * FROM enriched
