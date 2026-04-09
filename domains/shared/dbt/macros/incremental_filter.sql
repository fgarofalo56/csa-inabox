{#
    Standard incremental filter macro for bronze models reading from ADLS.
    Uses file modification time metadata for efficient incremental loads.

    Usage:
        {% if is_incremental() %}
        where {{ incremental_filter('_metadata.file_modification_time', '_dbt_loaded_at') }}
        {% endif %}
#}

{% macro incremental_filter(source_ts_col, loaded_ts_col) %}
    {{ source_ts_col }} > (select coalesce(max({{ loaded_ts_col }}), '1900-01-01') from {{ this }})
{% endmacro %}
