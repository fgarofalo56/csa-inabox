{{ config(
    materialized='view',
    tags=['gold', 'ml', 'training']
) }}

{#
    Gold layer: the feature set consumed by the training pipeline.
    Drops operational identifiers (application_id, application_ts)
    that should not leak into the model, and keeps the target
    (``defaulted``) alongside the predictors.  Schema matches
    ``contracts/loan_training_features.yaml`` 1:1.
#}

SELECT
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
    monthly_payment,
    payment_income_ratio,
    amount_income_ratio,
    defaulted
FROM {{ ref('slv_loan_features') }}
