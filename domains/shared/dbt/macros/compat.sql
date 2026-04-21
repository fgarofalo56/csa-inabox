{# Cross-engine compatibility macros.

   These macros abstract Databricks/Spark-specific functions so the dbt
   models can compile and run on both Databricks (production) and DuckDB
   (CI integration tests).
#}


{# ── Source / metadata shims ──────────────────────────────────────── #}

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


{# ── Type-casting shims ───────────────────────────────────────────── #}

{% macro as_string() %}
  {#- Spark uses STRING, DuckDB uses VARCHAR. -#}
  {%- if target.type == 'duckdb' -%}VARCHAR{%- else -%}STRING{%- endif -%}
{% endmacro %}


{# ── Date / time function shims ───────────────────────────────────── #}

{% macro current_date_expr() %}
  {#- Spark: current_date()  DuckDB: current_date (no parens). -#}
  {%- if target.type == 'duckdb' -%}
    current_date
  {%- else -%}
    current_date()
  {%- endif -%}
{% endmacro %}


{% macro year_of(expr) %}
  {#- Extract year. Spark: YEAR(x), DuckDB: extract(year from x). -#}
  {%- if target.type == 'duckdb' -%}
    extract(year from {{ expr }})
  {%- else -%}
    YEAR({{ expr }})
  {%- endif -%}
{% endmacro %}


{% macro month_of(expr) %}
  {%- if target.type == 'duckdb' -%}
    extract(month from {{ expr }})
  {%- else -%}
    MONTH({{ expr }})
  {%- endif -%}
{% endmacro %}


{% macro quarter_of(expr) %}
  {%- if target.type == 'duckdb' -%}
    extract(quarter from {{ expr }})
  {%- else -%}
    QUARTER({{ expr }})
  {%- endif -%}
{% endmacro %}


{% macro day_of_week(expr) %}
  {#- Spark: DAYOFWEEK(x), DuckDB: extract(dow from x). -#}
  {%- if target.type == 'duckdb' -%}
    extract(dow from {{ expr }})
  {%- else -%}
    DAYOFWEEK({{ expr }})
  {%- endif -%}
{% endmacro %}


{% macro datediff_expr(unit, start_expr, end_expr) %}
  {#- Spark: datediff(unit, start, end).  DuckDB: date_diff(unit, start, end). -#}
  {%- if target.type == 'duckdb' -%}
    date_diff('{{ unit }}', {{ start_expr }}, {{ end_expr }})
  {%- else -%}
    datediff('{{ unit }}', {{ start_expr }}, {{ end_expr }})
  {%- endif -%}
{% endmacro %}


{# ── Config shims ─────────────────────────────────────────────────── #}

{% macro ci_safe_file_format() %}
  {#- Return 'delta' on Databricks, omit on DuckDB (unsupported). -#}
  {%- if target.type == 'duckdb' -%}
    {#- DuckDB doesn't support file_format, return nothing -#}
  {%- else -%}
    delta
  {%- endif -%}
{% endmacro %}
