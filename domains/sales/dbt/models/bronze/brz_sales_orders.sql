{{
    config(
        materialized='incremental',
        unique_key='_surrogate_key',
        incremental_strategy='merge',
        file_format='delta',
        tags=['bronze', 'sales']
    )
}}

with source as (
    select * from {{ source('raw_sales', 'raw_sales_orders') }}
    {% if is_incremental() %}
    where _metadata.file_modification_time > (select max(_dbt_loaded_at) from {{ this }})
    {% endif %}
),

staged as (
    select
        {{ dbt_utils.generate_surrogate_key(['order_id']) }} as _surrogate_key,
        *,
        {{ bronze_audit_columns() }}
    from source
)

select * from staged
