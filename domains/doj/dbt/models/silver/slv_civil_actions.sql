{{
  config(
    materialized='incremental',
    unique_key='action_sk',
    incremental_strategy='merge',
    file_format='delta',
    tags=['silver', 'doj', 'civil', 'actions'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed civil actions with validation flags.
  Follows the flag-don't-drop pattern from the shared domain.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_civil_actions') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY action_id ORDER BY _ingested_at DESC
    ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['action_id']) }} AS action_sk,
        CAST(action_id AS BIGINT) AS action_id,
        CAST(case_id AS BIGINT) AS case_id,
        CAST(fiscal_year AS INT) AS fiscal_year,
        UPPER(TRIM(action_type)) AS action_type,
        CAST(filing_date AS DATE) AS filing_date,
        TRIM(parties_involved) AS parties_involved,
        UPPER(TRIM(industry_sector)) AS industry_sector,
        UPPER(TRIM(relief_sought)) AS relief_sought,
        UPPER(TRIM(outcome)) AS outcome,
        CAST(resolution_date AS DATE) AS resolution_date,
        _ingested_at,
        now() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1
),

validated AS (
    SELECT
        *,
        CASE WHEN action_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_action_id,
        CASE WHEN case_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_case_id,
        CASE WHEN filing_date IS NULL THEN TRUE ELSE FALSE END AS _is_missing_filing_date,
        CASE WHEN filing_date > current_date() THEN TRUE ELSE FALSE END AS _is_future_filing_date,
        CASE WHEN parties_involved IS NULL OR parties_involved = '' THEN TRUE ELSE FALSE END AS _is_missing_parties,
        CASE WHEN resolution_date IS NOT NULL AND resolution_date < filing_date THEN TRUE ELSE FALSE END AS _is_resolution_before_filing
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_action_id OR _is_missing_case_id OR _is_missing_filing_date
        OR _is_future_filing_date OR _is_missing_parties OR _is_resolution_before_filing
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_action_id THEN 'action_id null' END,
        CASE WHEN _is_missing_case_id THEN 'case_id null' END,
        CASE WHEN _is_missing_filing_date THEN 'filing_date null' END,
        CASE WHEN _is_future_filing_date THEN 'filing_date in future' END,
        CASE WHEN _is_missing_parties THEN 'parties_involved null/empty' END,
        CASE WHEN _is_resolution_before_filing THEN 'resolution_date before filing_date' END
    ) AS validation_errors
FROM validated