{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='case_id',
    incremental_strategy='merge',
    tags=['bronze', 'doj', 'antitrust', 'cases'],
    on_schema_change='fail'
  )
}}

SELECT
    case_id,
    case_name,
    case_type,
    filing_date,
    court_district,
    industry_sector,
    violation_type,
    status,
    defendant_name,
    defendant_type,
    resolution_date,
    _ingested_at,
    now() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    {{ source_file_path() }} AS _source_file

FROM {{ source('raw_doj', 'raw_antitrust_cases') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}