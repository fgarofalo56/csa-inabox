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
    {{ incremental_file_filter(this) }}
    {% endif %}
),

staged as (
    select
        {{ dbt_utils.generate_surrogate_key(['customer_id']) }} as _surrogate_key,
        *,
        now() as _dbt_loaded_at,
        {{ source_file_path_from_metadata() }} as _source_file,
        {{ source_file_modification_time() }} as _source_modified_at,
        '{{ invocation_id }}' as _dbt_run_id
    from source
)

select * from staged
