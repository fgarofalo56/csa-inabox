{{
    config(
        materialized='incremental',
        unique_key='customer_sk',
        incremental_strategy='merge',
        partition_by=['country_code'] if target.type != 'duckdb' else none,
        clustered_by=['customer_sk'] if target.type != 'duckdb' else none,
        file_format='delta' if target.type != 'duckdb' else none,
        tags=['silver', 'customers'],
        on_schema_change='fail'
    )
}}

/*
  Silver: Conformed customers.

  Two behaviour changes from prior versions (Archon tasks 310b5446 +
  0ac384b5):

  1. The customer_sk surrogate key is generated HERE (not in Bronze) so
     Bronze stays a raw ingestion layer — see brz_customers.sql.
  2. Silver FLAGS bad records with ``is_valid`` + ``validation_errors``
     rather than filtering them out. Bad data now reaches Silver with a
     clear lineage marker so the data-quality runner and dashboards can
     count and categorise it. Gold models filter to
     ``WHERE is_valid = true`` — see gld_customer_lifetime_value.sql.
*/

with bronze as (
    select * from {{ ref('brz_customers') }}
    {% if is_incremental() %}
    where _dbt_loaded_at > (select max(_dbt_loaded_at) from {{ this }})
    {% endif %}
),

-- Dedup: keep latest record per customer_id.  This is the one place we
-- still drop rows, and it's intentional — duplicate inbound rows for the
-- same customer are noise, not data loss.
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
        -- Surrogate key (moved here from Bronze per 310b5446).
        {{ dbt_utils.generate_surrogate_key(['customer_id']) }} as customer_sk,

        -- Natural key
        cast(customer_id as {{ as_string() }}) as customer_id,

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

        -- Metadata
        now() as _dbt_loaded_at,
        _source_file,
        _dbt_run_id
    from deduped
    where _row_num = 1
),

-- Validation: build individual quality flags, then aggregate them into
-- a single is_valid boolean + a human-readable validation_errors string.
validated as (
    select
        *,
        case when customer_id is null or customer_id = '' then true else false end as _is_missing_id,
        {{ flag_invalid_email('email') }} as _is_invalid_email,
        case when first_name = '' and last_name = '' then true else false end as _is_missing_name,
        case when created_at is null then true else false end as _is_missing_created_at
    from cleaned
)

select
    *,
    not (_is_missing_id or _is_invalid_email or _is_missing_name or _is_missing_created_at) as is_valid,
    concat_ws(
        '; ',
        case when _is_missing_id then 'customer_id missing' end,
        case when _is_invalid_email then 'email failed regex validation' end,
        case when _is_missing_name then 'first_name and last_name both empty' end,
        case when _is_missing_created_at then 'created_at null' end
    ) as validation_errors
from validated
