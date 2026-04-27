{{ config(materialized='view') }}
SELECT
    CAST(customer_id AS VARCHAR)        AS customer_id,
    CAST(customer_name AS VARCHAR)      AS customer_name,
    CAST(customer_segment AS VARCHAR)   AS customer_segment,
    CAST(country AS VARCHAR)            AS country,
    CAST(region AS VARCHAR)             AS region,
    CAST(signup_date AS DATE)           AS signup_date,
    CURRENT_TIMESTAMP                   AS _ingested_at
FROM {{ source('bronze', 'customers_raw') }}
