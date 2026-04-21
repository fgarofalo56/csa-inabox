{{ config(
    materialized='view',
    tags=['bronze', 'ml', 'loans']
) }}

{#
    Bronze layer: raw loan applications as ingested from the upstream
    source (Event Hub Capture / ADF pipeline in production, dbt seed
    in CI).  Only identity + type coercion here; no quality filtering,
    no winsorisation, no derived fields.
#}

WITH src AS (
    SELECT
        CAST(application_id AS VARCHAR) AS application_id,
        CAST(application_ts AS VARCHAR) AS application_ts,
        CAST(applicant_age AS INTEGER) AS applicant_age,
        CAST(annual_income AS DOUBLE) AS annual_income,
        CAST(loan_amount AS DOUBLE) AS loan_amount,
        CAST(loan_term_months AS INTEGER) AS loan_term_months,
        CAST(credit_score AS INTEGER) AS credit_score,
        CAST(employment_years AS DOUBLE) AS employment_years,
        CAST(debt_to_income AS DOUBLE) AS debt_to_income,
        CAST(home_ownership AS VARCHAR) AS home_ownership,
        CAST(loan_purpose AS VARCHAR) AS loan_purpose,
        CAST(delinquencies_2yr AS INTEGER) AS delinquencies_2yr,
        CAST(defaulted AS INTEGER) AS defaulted
    FROM {{ source('ml_lifecycle', 'loan_applications') }}
)

SELECT
    *,
    CURRENT_TIMESTAMP AS ingestion_ts,
    'seed_or_eventhub_capture' AS source_system
FROM src
