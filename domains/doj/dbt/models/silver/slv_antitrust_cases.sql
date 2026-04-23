{{
  config(
    materialized='incremental',
    unique_key='case_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'doj', 'antitrust', 'cases'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed antitrust cases with validation flags.
  Follows the flag-don't-drop pattern from the shared domain.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_antitrust_cases') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY case_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['case_id']) }} AS case_sk,
        CAST(case_id AS BIGINT) AS case_id,
        TRIM(case_name) AS case_name,
        UPPER(TRIM(case_type)) AS case_type,
        CAST(filing_date AS DATE) AS filing_date,
        UPPER(TRIM(court_district)) AS court_district,
        UPPER(TRIM(industry_sector)) AS industry_sector,
        UPPER(TRIM(violation_type)) AS violation_type,
        UPPER(TRIM(status)) AS status,
        TRIM(defendant_name) AS defendant_name,
        UPPER(TRIM(defendant_type)) AS defendant_type,
        CAST(resolution_date AS DATE) AS resolution_date,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN case_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_case_id,
        CASE WHEN case_name IS NULL OR case_name = '' THEN TRUE ELSE FALSE END AS _is_missing_case_name,
        CASE WHEN case_type IS NULL THEN TRUE ELSE FALSE END AS _is_missing_case_type,
        CASE WHEN filing_date IS NULL THEN TRUE ELSE FALSE END AS _is_missing_filing_date,
        CASE WHEN filing_date > current_date() THEN TRUE ELSE FALSE END AS _is_future_filing_date,
        CASE WHEN resolution_date IS NOT NULL AND resolution_date < filing_date THEN TRUE ELSE FALSE END AS _is_resolution_before_filing,
        CASE WHEN defendant_name IS NULL OR defendant_name = '' THEN TRUE ELSE FALSE END AS _is_missing_defendant
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_case_id OR _is_missing_case_name OR _is_missing_case_type
        OR _is_missing_filing_date OR _is_future_filing_date
        OR _is_resolution_before_filing OR _is_missing_defendant
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_case_id THEN 'case_id null' END,
        CASE WHEN _is_missing_case_name THEN 'case_name null/empty' END,
        CASE WHEN _is_missing_case_type THEN 'case_type null' END,
        CASE WHEN _is_missing_filing_date THEN 'filing_date null' END,
        CASE WHEN _is_future_filing_date THEN 'filing_date in future' END,
        CASE WHEN _is_resolution_before_filing THEN 'resolution_date before filing_date' END,
        CASE WHEN _is_missing_defendant THEN 'defendant_name null/empty' END
    ) AS validation_errors
FROM validated