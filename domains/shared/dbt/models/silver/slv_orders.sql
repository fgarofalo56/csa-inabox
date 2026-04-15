{{
  config(
    materialized='incremental',
    unique_key='order_sk',
    incremental_strategy='merge',
    partition_by=['order_date'],
    clustered_by=['customer_id'],
    file_format='delta',
    tags=['silver', 'orders'],
    on_schema_change='fail'
  )
}}

/*
  Silver: Conformed orders.

  Two behaviour changes from prior versions (Archon tasks 310b5446 +
  0ac384b5):

  1. The order_sk surrogate key is generated HERE (not in Bronze) so
     Bronze stays a raw ingestion layer — see brz_orders.sql.
  2. Silver FLAGS bad records with ``is_valid`` + ``validation_errors``
     rather than silently dropping them with WHERE filters. Bad data now
     reaches Silver with a clear lineage marker so downstream quality
     monitoring can count and categorise it. Gold models filter to
     ``WHERE is_valid = true``.
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
        -- Surrogate key (moved here from Bronze per 310b5446).
        {{ dbt_utils.generate_surrogate_key(['order_id']) }} AS order_sk,

        CAST(order_id AS BIGINT) AS order_id,
        CAST(customer_id AS BIGINT) AS customer_id,
        CAST(order_date AS DATE) AS order_date,
        CAST(total_amount AS DECIMAL(18, 2)) AS total_amount,
        UPPER(TRIM(status)) AS status,
        _ingested_at,
        current_timestamp() AS _dbt_loaded_at
    FROM deduplicated
    WHERE _row_num = 1  -- intentional dedup; see module docstring
),

-- Validation flags — one per rule, aggregated below.
validated AS (
    SELECT
        *,
        CASE WHEN order_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_order_id,
        CASE WHEN customer_id IS NULL THEN TRUE ELSE FALSE END AS _is_missing_customer_id,
        CASE WHEN order_date IS NULL THEN TRUE ELSE FALSE END AS _is_missing_order_date,
        CASE WHEN total_amount < 0 THEN TRUE ELSE FALSE END AS _is_negative_amount,
        CASE WHEN order_date > current_date() THEN TRUE ELSE FALSE END AS _is_future_date
    FROM cleaned
)

SELECT
    *,
    NOT (
        _is_missing_order_id
        OR _is_missing_customer_id
        OR _is_missing_order_date
        OR _is_negative_amount
        OR _is_future_date
    ) AS is_valid,
    CONCAT_WS(
        '; ',
        CASE WHEN _is_missing_order_id THEN 'order_id null' END,
        CASE WHEN _is_missing_customer_id THEN 'customer_id null' END,
        CASE WHEN _is_missing_order_date THEN 'order_date null' END,
        CASE WHEN _is_negative_amount THEN 'total_amount negative' END,
        CASE WHEN _is_future_date THEN 'order_date in the future' END
    ) AS validation_errors
FROM validated
