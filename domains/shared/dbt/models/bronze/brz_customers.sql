{{
    config(
        materialized='incremental',
        unique_key='_surrogate_key',
        incremental_strategy='merge',
        file_format='delta',
        tags=['bronze', 'customers'],
        on_schema_change='fail'
    )
}}

with source as (
    select * from {{ source('raw_data', 'sample_customers') }}
    {% if is_incremental() %}
    where _metadata.file_modification_time > (select max(_dbt_loaded_at) from {{ this }})
    {% endif %}
),

staged as (
    select
        {{ dbt_utils.generate_surrogate_key(['customer_id']) }} as _surrogate_key,
        *,
        current_timestamp() as _dbt_loaded_at,
        _metadata.file_path as _source_file,
        _metadata.file_modification_time as _source_modified_at,
        '{{ invocation_id }}' as _dbt_run_id
    from source
)

select * from staged
