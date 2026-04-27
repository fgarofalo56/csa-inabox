{{ config(materialized='incremental', unique_key='customer_key') }}
-- SCD Type 2 customer dimension. New row per customer change; valid_to/is_current
-- closed by upstream merge logic (not shown here for brevity).
SELECT
    ROW_NUMBER() OVER (ORDER BY customer_id, _ingested_at) AS customer_key,
    customer_id,
    customer_name,
    customer_segment,
    country,
    region,
    _ingested_at AS valid_from,
    CAST(NULL AS TIMESTAMP) AS valid_to,
    TRUE AS is_current
FROM {{ ref('silver_customers') }}
{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(valid_from) FROM {{ this }})
{% endif %}
