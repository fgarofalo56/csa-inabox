{# Override dbt's default generate_schema_name to use custom schema names
   as-is (without prefixing the target schema).  This ensures:
   
     +schema: raw     → creates DuckDB schema "raw"  (not "main_raw")
     +schema: bronze  → creates DuckDB schema "bronze"
   
   Which matches the source definitions (schema: raw) so seeds and models
   land in the same schema that bronze {{ source(...) }} references expect.
   
   Without this override dbt prepends {{ target.schema }}_ by default,
   breaking DuckDB CI where the profile schema is "main".
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ custom_schema_name | trim }}
    {%- endif -%}
{%- endmacro %}
