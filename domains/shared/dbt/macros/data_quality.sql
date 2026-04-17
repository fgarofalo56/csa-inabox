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
    {% if target.type == 'duckdb' %}
    case when regexp_matches({{ column_name }}, '{{ var("email_regex") }}')
         then false else true end
    {% else %}
    case when {{ column_name }} rlike '{{ var("email_regex") }}'
         then false else true end
    {% endif %}
{% endmacro %}
