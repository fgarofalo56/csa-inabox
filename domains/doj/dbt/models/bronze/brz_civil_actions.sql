{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='action_id',
    incremental_strategy='merge',
    tags=['bronze', 'doj', 'civil', 'actions'],
    on_schema_change='fail'
  )
}}

SELECT
    action_id,
    case_id,
    fiscal_year,
    action_type,
    filing_date,
    parties_involved,
    industry_sector,
    relief_sought,
    outcome,
    resolution_date,
    _ingested_at,
    now() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    {{ source_file_path() }} AS _source_file

FROM {{ source('raw_doj', 'raw_civil_actions') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}