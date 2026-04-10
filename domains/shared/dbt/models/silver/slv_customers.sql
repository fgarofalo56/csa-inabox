{{
    config(
        materialized='incremental',
        unique_key='customer_id',
        incremental_strategy='merge',
        file_format='delta',
        tags=['silver', 'customers']
    )
}}

with bronze as (
    select * from {{ ref('brz_customers') }}
    {% if is_incremental() %}
    where _dbt_loaded_at > (select max(_dbt_loaded_at) from {{ this }})
    {% endif %}
),

-- Dedup: keep latest record per customer
deduped as (
    select
        *,
        row_number() over (
            partition by customer_id
            order by _source_modified_at desc, _dbt_loaded_at desc
        ) as _row_num
    from bronze
),

cleaned as (
    select
        -- Keys
        cast(customer_id as string) as customer_id,

        -- Attributes
        trim(upper(coalesce(first_name, ''))) as first_name,
        trim(upper(coalesce(last_name, ''))) as last_name,
        trim(lower(coalesce(email, ''))) as email,
        trim(coalesce(phone, '')) as phone,
        trim(coalesce(address_line1, '')) as address_line1,
        trim(coalesce(address_line2, '')) as address_line2,
        trim(upper(coalesce(city, ''))) as city,
        trim(upper(coalesce(state, ''))) as state_code,
        trim(coalesce(postal_code, '')) as postal_code,
        trim(upper(coalesce(country, 'US'))) as country_code,

        -- Dates
        cast(created_at as timestamp) as created_at,
        cast(updated_at as timestamp) as updated_at,

        -- Data quality flags (email regex lives in
        -- macros/data_quality.sql, sourced from dbt_project.yml var)
        {{ flag_invalid_email('email') }} as _is_invalid_email,
        case when customer_id is null then true else false end as _is_missing_id,

        -- Metadata
        current_timestamp() as _dbt_loaded_at,
        _source_file,
        _dbt_run_id
    from deduped
    where _row_num = 1
)

select * from cleaned
