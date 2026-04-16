{{
    config(
        materialized='incremental',
        unique_key='_surrogate_key',
        incremental_strategy='merge',
        file_format='delta',
        tags=['bronze', 'sales'],
        on_schema_change='fail'
    )
}}

/*
  Bronze: Raw sales orders.
  Preserves all source columns; adds surrogate key and ingestion metadata.
*/

with source as (
    select * from {{ source('raw_sales', 'raw_sales_orders') }}
    {% if is_incremental() %}
    where _ingested_at > (select max(_dbt_loaded_at) from {{ this }})
    {% endif %}
),

staged as (
    select
        {{ dbt_utils.generate_surrogate_key(['order_id']) }} as _surrogate_key,
        order_id,
        customer_id,
        product_id,
        quantity,
        unit_price,
        order_date,
        sales_region,
        sales_channel,
        _ingested_at,
        now() as _dbt_loaded_at,
        '{{ invocation_id }}' as _dbt_run_id
    from source
)

select * from staged
