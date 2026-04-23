{{
  config(
    materialized='incremental',
    file_format='delta',
    unique_key='review_id',
    incremental_strategy='merge',
    tags=['bronze', 'doj', 'merger', 'reviews'],
    on_schema_change='fail'
  )
}}

SELECT
    review_id,
    fiscal_year,
    transaction_id,
    acquiring_party,
    target_party,
    transaction_value,
    industry_sector,
    review_outcome,
    hhi_pre_merger,
    hhi_post_merger,
    hhi_delta,
    market_definition,
    review_start_date,
    review_end_date,
    _ingested_at,
    now() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    {{ source_file_path() }} AS _source_file

FROM {{ source('raw_doj', 'raw_merger_reviews') }}

{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}