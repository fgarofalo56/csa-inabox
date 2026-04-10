{% macro input_file_name() %}
  {#
    Compatibility shim for CI environments.

    In Databricks/Spark, input_file_name() returns the source file path.
    In DuckDB (used for CI integration tests), this function doesn't exist.
    This macro provides a safe fallback so the same dbt models compile and
    run correctly in both environments.

    All domains inherit this via macro-paths referencing ../../shared/dbt/macros.
  #}
  {% if target.type == 'duckdb' %}
    'ci-seed-file'
  {% else %}
    input_file_name()
  {% endif %}
{% endmacro %}
