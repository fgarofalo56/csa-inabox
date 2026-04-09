{#
    Wrapper around dbt_utils.generate_surrogate_key for consistent hashing.
    Override this macro if you need a different hashing strategy (e.g., SHA-256).
#}

{% macro csa_surrogate_key(field_list) %}
    {{ dbt_utils.generate_surrogate_key(field_list) }}
{% endmacro %}
