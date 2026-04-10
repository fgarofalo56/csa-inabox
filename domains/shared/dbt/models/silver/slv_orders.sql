{{
  config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    partition_by=['order_date'],
    clustered_by=['customer_id'],
    file_format='delta',
    tags=['silver', 'orders']
  )
}}

/*
  Silver: Conformed orders
  Applies data quality, deduplication, type casting, and business rules.
*/

WITH source AS (
    SELECT * FROM {{ ref('brz_orders') }}
    {% if is_incremental() %}
    WHERE _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

deduplicated AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY order_id
            ORDER BY _ingested_at DESC
        ) AS _row_num
    FROM source
),

cleaned AS (
    SELECT
        CAST(order_id AS BIGINT) AS order_id,
        CAST(customer_id AS BIGINT) AS customer_id,
        CAST(order_date AS DATE) AS order_date,
        CAST(total_amount AS DECIMAL(18, 2)) AS total_amount,
        UPPER(TRIM(status)) AS status,
        _ingested_at,
        current_timestamp() AS _dbt_loaded_at,

        -- Data quality flags
        CASE
            WHEN total_amount < 0 THEN TRUE
            ELSE FALSE
        END AS _is_negative_amount,

        CASE
            WHEN order_date > current_date() THEN TRUE
            ELSE FALSE
        END AS _is_future_date

    FROM deduplicated
    WHERE _row_num = 1
      AND order_id IS NOT NULL
)

SELECT * FROM cleaned
