{{
    config(
        materialized='incremental',
        unique_key='order_id',
        incremental_strategy='merge',
        file_format='delta',
        tags=['silver', 'sales']
    )
}}

with bronze as (
    select * from {{ ref('brz_sales_orders') }}
    {% if is_incremental() %}
    where _dbt_loaded_at > (select max(_dbt_loaded_at) from {{ this }})
    {% endif %}
),

deduped as (
    select
        *,
        row_number() over (
            partition by order_id
            order by _source_modified_at desc, _dbt_loaded_at desc
        ) as _row_num
    from bronze
),

cleaned as (
    select
        cast(order_id as string) as order_id,
        cast(customer_id as string) as customer_id,
        cast(product_id as string) as product_id,
        cast(quantity as int) as quantity,
        cast(unit_price as decimal(18, 2)) as unit_price,
        cast(quantity as decimal(18, 2)) * cast(unit_price as decimal(18, 2)) as line_total,
        cast(order_date as date) as order_date,
        trim(upper(coalesce(sales_region, 'UNKNOWN'))) as sales_region,
        trim(upper(coalesce(sales_channel, 'UNKNOWN'))) as sales_channel,

        -- Data quality
        {{ flag_negative_value('unit_price') }} as _is_negative_price,
        {{ flag_future_date('order_date') }} as _is_future_date,
        case when quantity <= 0 then true else false end as _is_invalid_quantity,

        current_timestamp() as _dbt_loaded_at,
        _source_file,
        _dbt_run_id
    from deduped
    where _row_num = 1
)

select * from cleaned
