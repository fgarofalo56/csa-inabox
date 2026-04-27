{{ config(materialized='incremental', unique_key='customer_id') }}
SELECT
    customer_id,
    customer_name,
    customer_segment,
    country,
    region,
    signup_date,
    _ingested_at
FROM {{ ref('bronze_customers') }}
WHERE customer_id IS NOT NULL
{% if is_incremental() %}
  AND _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
