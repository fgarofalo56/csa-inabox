{# NOTE: This macro is available for multi-tenant row-level filtering but is not currently used by any model. #}

{#
    Tenant-scoped data filtering macro for multi-tenant deployments.

    In a multi-tenant CSA-in-a-Box deployment using logical isolation
    (shared infrastructure with row-level filtering), append this macro
    to WHERE clauses so that queries only return data belonging to the
    active tenant.

    The macro is a no-op when the dbt variable `tenant_id` is not set,
    making it safe to use in both single-tenant and multi-tenant
    deployments without code changes.

    Usage:
        SELECT *
        FROM {{ ref('stg_orders') }}
        WHERE 1=1
          {{ tenant_filter() }}

        -- With a custom column name:
        SELECT *
        FROM {{ ref('stg_customers') }}
        WHERE 1=1
          {{ tenant_filter('organization_id') }}

    Invocation examples:
        -- Single-tenant (no filtering):
        dbt run

        -- Multi-tenant (filter to 'contoso'):
        dbt run --vars '{"tenant_id": "contoso"}'

    See docs/MULTI_TENANT.md §3.2 for the logical isolation pattern.
#}

{% macro tenant_filter(column_name='tenant_id') %}
  {% if var('tenant_id', none) is not none %}
    AND {{ column_name }} = '{{ var("tenant_id") }}'
  {% endif %}
{% endmacro %}
