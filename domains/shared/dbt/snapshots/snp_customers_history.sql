-- SCD Type 2 snapshot for customer dimension history.
--
-- Captures every change to validated Silver customer records over time,
-- enabling point-in-time analytics ("What segment was this customer in
-- last quarter?") and audit trails.
--
-- The check strategy compares all tracked columns on each run.  When a
-- column value changes, the current row is closed (dbt_valid_to is set)
-- and a new row is opened.

{% snapshot snp_customers_history %}

{{
    config(
        target_schema   = 'snapshots',
        unique_key      = 'customer_sk',
        strategy        = 'check',
        check_cols      = [
            'first_name',
            'last_name',
            'email',
            'phone',
            'country_code',
            'state_code',
            'city',
        ],
        file_format     = 'delta' if target.type != 'duckdb' else none,
        tags            = ['snapshot', 'scd2', 'customers'],
    )
}}

    SELECT
        customer_sk,
        customer_id,
        first_name,
        last_name,
        email,
        phone,
        country_code,
        state_code,
        city,
        _dbt_loaded_at
    FROM {{ ref('slv_customers') }}
    WHERE is_valid = TRUE

{% endsnapshot %}
