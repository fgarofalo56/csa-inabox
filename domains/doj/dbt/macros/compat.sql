{# Cross-engine compatibility macros.

   These macros abstract Databricks/Spark-specific functions so the dbt
   models can compile and run on both Databricks (production) and DuckDB
   (CI integration tests).
#}


{% macro source_file_path() %}
  {%- if target.type == 'duckdb' -%}
    'ci-seed-file'
  {%- else -%}
    input_file_name()
  {%- endif -%}
{% endmacro %}


{% macro source_file_modification_time() %}
  {%- if target.type == 'duckdb' -%}
    now()
  {%- else -%}
    _metadata.file_modification_time
  {%- endif -%}
{% endmacro %}


{% macro source_file_path_from_metadata() %}
  {%- if target.type == 'duckdb' -%}
    'ci-seed-file'
  {%- else -%}
    _metadata.file_path
  {%- endif -%}
{% endmacro %}


{% macro incremental_file_filter(this_ref) %}
  {#- In Databricks, filter by file modification time for efficient incremental
      loads from ADLS.  In DuckDB CI we skip the filter since seeds are
      always fully loaded. -#}
  {%- if target.type != 'duckdb' -%}
    where _metadata.file_modification_time > (select max(_dbt_loaded_at) from {{ this_ref }})
  {%- endif -%}
{% endmacro %}