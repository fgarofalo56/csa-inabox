-- SCD Type 2 snapshot for product dimension history.
--
-- Tracks changes to product attributes (name, category, price) over
-- time so Gold-layer analytics can join at the correct historical state.

{% snapshot snp_products_history %}

{{
    config(
        target_database = var('gold_database', 'gold'),
        target_schema   = 'snapshots',
        unique_key      = 'product_sk',
        strategy        = 'check',
        check_cols      = [
            'product_name',
            'category',
            'unit_price',
        ],
        file_format     = 'delta',
        tags            = ['snapshot', 'scd2', 'products'],
    )
}}

    SELECT
        product_sk,
        product_id,
        product_name,
        category,
        unit_price,
        _dbt_loaded_at
    FROM {{ ref('slv_products') }}
    WHERE is_valid = TRUE

{% endsnapshot %}
