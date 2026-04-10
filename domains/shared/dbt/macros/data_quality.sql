{#
    Data quality macros used across medallion layers.
#}

{# Check if a date column has future dates #}
{% macro flag_future_date(column_name) %}
    case when {{ column_name }} > current_date() then true else false end
{% endmacro %}

{# Check if a numeric column has negative values #}
{% macro flag_negative_value(column_name) %}
    case when {{ column_name }} < 0 then true else false end
{% endmacro %}

{#
    Validate email format with the canonical regex defined in
    dbt_project.yml var `email_regex` (kept in sync with
    governance/common/validation.py EMAIL_REGEX_PATTERN).
    Returns true when the email is invalid so it can be assigned to a
    `_is_invalid_email` quality flag column.
#}
{% macro flag_invalid_email(column_name) %}
    case when {{ column_name }} rlike '{{ var("email_regex") }}'
         then false else true end
{% endmacro %}

{# Standardize string: trim + uppercase #}
{% macro clean_string(column_name, case='upper') %}
    {% if case == 'lower' %}
        trim(lower(coalesce({{ column_name }}, '')))
    {% elif case == 'title' %}
        trim(initcap(coalesce({{ column_name }}, '')))
    {% else %}
        trim(upper(coalesce({{ column_name }}, '')))
    {% endif %}
{% endmacro %}

{# Generate audit columns for bronze layer #}
{% macro bronze_audit_columns() %}
    current_timestamp() as _dbt_loaded_at,
    _metadata.file_path as _source_file,
    _metadata.file_modification_time as _source_modified_at,
    '{{ invocation_id }}' as _dbt_run_id
{% endmacro %}
