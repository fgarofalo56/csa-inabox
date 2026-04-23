{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='filing_id',
    incremental_strategy='merge',
    tags=['bronze', 'doj', 'hsr', 'filings'],
    on_schema_change='fail'
  )
}}

SELECT
    filing_id,
    fiscal_year,
    transaction_id,
    acquiring_party,
    target_party,
    transaction_value,
    filing_date,
    industry_naics_code,
    industry_description,
    filing_fee,
    review_status,
    review_days,
    _ingested_at,
    now() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    {{ source_file_path() }} AS _source_file

FROM {{ source('raw_doj', 'raw_hsr_filings') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}