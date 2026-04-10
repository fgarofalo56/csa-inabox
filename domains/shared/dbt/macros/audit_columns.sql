{#
    Standard audit column macros.

    Adds consistent lineage and metadata columns across all layers:
      - _dbt_loaded_at    — when dbt processed the row
      - _dbt_run_id       — invocation ID for tracing back to a specific run
      - _source_file      — ADLS file path (Bronze only)
      - _dbt_refreshed_at — when Gold aggregates were last recalculated
#}


{# Bronze audit columns: file-level lineage from ADLS raw container. #}
{% macro bronze_audit_columns() %}
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id,
    input_file_name() AS _source_file
{% endmacro %}


{# Silver audit columns: processing metadata without file-level lineage. #}
{% macro silver_audit_columns() %}
    current_timestamp() AS _dbt_loaded_at,
    '{{ invocation_id }}' AS _dbt_run_id
{% endmacro %}


{# Gold audit columns: refresh tracking for aggregate tables. #}
{% macro gold_audit_columns() %}
    current_timestamp() AS _dbt_refreshed_at,
    '{{ invocation_id }}' AS _dbt_run_id
{% endmacro %}


{#
    Generic audit columns for any layer.
    Pass layer='bronze', 'silver', or 'gold' to get the right set.
#}
{% macro audit_columns(layer='silver') %}
    {% if layer == 'bronze' %}
        {{ bronze_audit_columns() }}
    {% elif layer == 'gold' %}
        {{ gold_audit_columns() }}
    {% else %}
        {{ silver_audit_columns() }}
    {% endif %}
{% endmacro %}
