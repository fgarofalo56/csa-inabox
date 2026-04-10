{#
    SCD Type 2 macro for slowly changing dimensions.

    Usage:
        {{ scd_type2(
            source_model='stg_customers',
            unique_key='customer_id',
            tracked_columns=['customer_name', 'email', 'region'],
            surrogate_key='customer_sk'
        ) }}

    Generates a snapshot-style model that tracks historical changes by
    managing effective_from / effective_to date ranges and an is_current
    flag.  New rows are inserted when tracked columns change; the
    previous row's effective_to is closed.

    NOTE: For most CSA-in-a-Box models, dbt snapshots (snapshot-paths)
    are the preferred mechanism for SCD Type 2.  This macro is provided
    for teams that need SCD behaviour in a regular model context (e.g.,
    when snapshots are not supported by the target warehouse adapter).
#}

{% macro scd_type2(source_model, unique_key, tracked_columns, surrogate_key='_surrogate_key') %}

WITH source AS (
    SELECT * FROM {{ ref(source_model) }}
),

-- Hash the tracked columns to detect changes
source_hashed AS (
    SELECT
        *,
        {{ dbt_utils.generate_surrogate_key(tracked_columns) }} AS _row_hash
    FROM source
),

{% if is_incremental() %}

-- Current dimension rows
existing AS (
    SELECT * FROM {{ this }}
    WHERE is_current = TRUE
),

-- Detect changes: new rows or rows with different hash
changes AS (
    SELECT
        s.*,
        e.{{ surrogate_key }} AS _existing_sk,
        e._row_hash AS _existing_hash
    FROM source_hashed s
    LEFT JOIN existing e ON s.{{ unique_key }} = e.{{ unique_key }}
    WHERE e.{{ surrogate_key }} IS NULL          -- new record
       OR s._row_hash != e._existing_hash        -- changed record
),

-- Close old records
closed AS (
    SELECT
        e.{{ surrogate_key }},
        e.{{ unique_key }},
        {% for col in tracked_columns %}
        e.{{ col }},
        {% endfor %}
        e._row_hash,
        e.effective_from,
        current_timestamp() AS effective_to,
        FALSE AS is_current,
        e._dbt_loaded_at
    FROM existing e
    INNER JOIN changes c ON e.{{ unique_key }} = c.{{ unique_key }}
    WHERE e.is_current = TRUE
),

-- Open new records
opened AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key([unique_key, '_row_hash']) }} AS {{ surrogate_key }},
        c.{{ unique_key }},
        {% for col in tracked_columns %}
        c.{{ col }},
        {% endfor %}
        c._row_hash,
        current_timestamp() AS effective_from,
        CAST(NULL AS TIMESTAMP) AS effective_to,
        TRUE AS is_current,
        current_timestamp() AS _dbt_loaded_at
    FROM changes c
),

final AS (
    SELECT * FROM closed
    UNION ALL
    SELECT * FROM opened
)

{% else %}

-- Initial load: all rows are current
final AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key([unique_key, '_row_hash']) }} AS {{ surrogate_key }},
        {{ unique_key }},
        {% for col in tracked_columns %}
        {{ col }},
        {% endfor %}
        _row_hash,
        current_timestamp() AS effective_from,
        CAST(NULL AS TIMESTAMP) AS effective_to,
        TRUE AS is_current,
        current_timestamp() AS _dbt_loaded_at
    FROM source_hashed
)

{% endif %}

SELECT * FROM final

{% endmacro %}
