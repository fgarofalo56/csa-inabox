{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='enforcement_id',
    incremental_strategy='merge',
    tags=['bronze', 'doj', 'criminal', 'enforcement'],
    on_schema_change='fail'
  )
}}

SELECT
    enforcement_id,
    case_id,
    fiscal_year,
    defendant_name,
    defendant_type,
    offense_type,
    fine_amount,
    jail_days_imposed,
    restitution_amount,
    plea_type,
    sentencing_date,
    _ingested_at,
    now() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    {{ source_file_path() }} AS _source_file

FROM {{ source('raw_doj', 'raw_criminal_enforcement') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}