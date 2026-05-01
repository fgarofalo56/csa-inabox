-- ==========================================================================
-- Fact Model: Encounters (Enriched)
-- Adds length-of-stay, 30-day readmission flags, and discharge context.
-- All data is synthetic — no real PHI.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='encounter_id',
    schema='silver'
) }}

WITH staged AS (
    SELECT * FROM {{ ref('stg_encounters') }}
),

-- Self-join to detect 30-day readmissions
with_readmit AS (
    SELECT
        curr.encounter_id,
        curr.patient_id,
        curr.admit_date,
        curr.discharge_date,
        curr.facility,
        curr.department,
        curr.encounter_type,
        curr.discharge_disposition,
        curr.payer,
        curr.drg_code,
        curr.ingested_at,

        -- Length of stay in days
        DATEDIFF(curr.discharge_date, curr.admit_date)  AS length_of_stay_days,

        -- 30-day readmission flag: did this patient have a subsequent
        -- inpatient encounter within 30 days of discharge?
        CASE
            WHEN EXISTS (
                SELECT 1
                FROM {{ ref('stg_encounters') }} nxt
                WHERE nxt.patient_id = curr.patient_id
                  AND nxt.admit_date > curr.discharge_date
                  AND nxt.admit_date <= DATE_ADD(curr.discharge_date, 30)
                  AND nxt.encounter_type = 'Inpatient'
                  AND nxt.encounter_id != curr.encounter_id
            ) THEN TRUE
            ELSE FALSE
        END                                             AS is_30day_readmission,

        -- Days to next admission (NULL if no readmission)
        (
            SELECT MIN(DATEDIFF(nxt.admit_date, curr.discharge_date))
            FROM {{ ref('stg_encounters') }} nxt
            WHERE nxt.patient_id = curr.patient_id
              AND nxt.admit_date > curr.discharge_date
              AND nxt.encounter_type = 'Inpatient'
              AND nxt.encounter_id != curr.encounter_id
        )                                               AS days_to_next_admission,

        CURRENT_TIMESTAMP()                             AS processed_at

    FROM staged curr
)

SELECT * FROM with_readmit

{% if is_incremental() %}
WHERE discharge_date > (
    SELECT MAX(discharge_date) FROM {{ this }}
)
{% endif %}
