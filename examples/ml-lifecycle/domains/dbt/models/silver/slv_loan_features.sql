{{ config(
    materialized='view',
    tags=['silver', 'ml', 'features']
) }}

{#
    Silver layer: one row per unique application, with:
      * FICO-range clipping on credit_score
      * Income floor (winsorises the bottom tail so log transforms
        don't explode)
      * Monthly payment estimated as loan_amount / loan_term_months
      * payment_income_ratio and amount_income_ratio derived here so
        the Gold layer stays declarative.

    No join logic is needed — this is a single-table pipeline for the
    worked example.  In production you would enrich with credit-bureau
    attributes here.
#}

WITH bronze AS (
    SELECT * FROM {{ ref('brz_loan_applications') }}
),

cleaned AS (
    SELECT
        application_id,
        application_ts,
        applicant_age,
        -- Winsorise very small incomes to the documented floor.
        CASE
            WHEN annual_income < {{ var('income_floor_usd') }}
                THEN CAST({{ var('income_floor_usd') }} AS DOUBLE)
            ELSE annual_income
        END AS annual_income,
        loan_amount,
        loan_term_months,
        LEAST(
            GREATEST(credit_score, {{ var('min_credit_score') }}),
            {{ var('max_credit_score') }}
        ) AS credit_score,
        employment_years,
        LEAST(debt_to_income, CAST({{ var('max_debt_to_income') }} AS DOUBLE)) AS debt_to_income,
        home_ownership,
        loan_purpose,
        delinquencies_2yr,
        defaulted
    FROM bronze
)

SELECT
    application_id,
    application_ts,
    applicant_age,
    annual_income,
    loan_amount,
    loan_term_months,
    credit_score,
    employment_years,
    debt_to_income,
    home_ownership,
    loan_purpose,
    delinquencies_2yr,
    defaulted,

    -- Derived features
    CAST(loan_amount AS DOUBLE) / NULLIF(loan_term_months, 0) AS monthly_payment,
    (CAST(loan_amount AS DOUBLE) / NULLIF(loan_term_months, 0))
        / NULLIF(annual_income / 12.0, 0) AS payment_income_ratio,
    CAST(loan_amount AS DOUBLE) / NULLIF(annual_income, 0) AS amount_income_ratio
FROM cleaned
