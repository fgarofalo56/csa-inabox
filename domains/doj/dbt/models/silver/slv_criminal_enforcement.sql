{{
  config(
    materialized='incremental',
    unique_key='enforcement_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'doj', 'criminal', 'enforcement'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed criminal enforcement with validation flags.
  Follows the flag-don't-drop pattern from the shared domain.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_criminal_enforcement') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY enforcement_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['enforcement_id']) }} AS enforcement_sk,
        CAST(enforcement_id AS BIGINT) AS enforcement_id,
        CAST(case_id AS BIGINT) AS case_id,
        CAST(fiscal_year AS INT) AS fiscal_year,
        TRIM(defendant_name) AS defendant_name,
        UPPER(TRIM(defendant_type)) AS defendant_type,
        UPPER(TRIM(offense_type)) AS offense_type,
        CAST(fine_amount AS DECIMAL(18, 2)) AS fine_amount,
        CAST(jail_days_imposed AS INT) AS jail_days_imposed,
        CAST(restitution_amount AS DECIMAL(18, 2)) AS restitution_amount,
        UPPER(TRIM(plea_type)) AS plea_type,
        CAST(sentencing_date AS DATE) AS sentencing_date,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN enforcement_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_enforcement_id,
        CASE WHEN case_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_case_id,
        CASE WHEN defendant_name IS NULL OR defendant_name = '' THEN TRUE ELSE FALSE END AS _is_missing_defendant_name,
        CASE WHEN fine_amount IS NOT NULL AND fine_amount < 0 THEN TRUE ELSE FALSE END AS _is_negative_fine_amount,
        CASE WHEN jail_days_imposed IS NOT NULL AND jail_days_imposed < 0 THEN TRUE ELSE FALSE END AS _is_negative_jail_days,
        CASE WHEN restitution_amount IS NOT NULL AND restitution_amount < 0 THEN TRUE ELSE FALSE END AS _is_negative_restitution,
        CASE WHEN sentencing_date IS NOT NULL AND sentencing_date > current_date() THEN TRUE ELSE FALSE END AS _is_future_sentencing_date
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_enforcement_id OR _is_missing_case_id OR _is_missing_defendant_name
        OR _is_negative_fine_amount OR _is_negative_jail_days
        OR _is_negative_restitution OR _is_future_sentencing_date
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_enforcement_id THEN 'enforcement_id null' END,
        CASE WHEN _is_missing_case_id THEN 'case_id null' END,
        CASE WHEN _is_missing_defendant_name THEN 'defendant_name null/empty' END,
        CASE WHEN _is_negative_fine_amount THEN 'fine_amount negative' END,
        CASE WHEN _is_negative_jail_days THEN 'jail_days_imposed negative' END,
        CASE WHEN _is_negative_restitution THEN 'restitution_amount negative' END,
        CASE WHEN _is_future_sentencing_date THEN 'sentencing_date in future' END
    ) AS validation_errors
FROM validated