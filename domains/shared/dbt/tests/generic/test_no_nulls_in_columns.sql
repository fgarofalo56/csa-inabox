{#
    Generic test: Assert that specified columns have no null values.
    Usage in schema.yml:
        tests:
          - no_nulls_in_columns:
              columns: ['col_a', 'col_b']
#}

{% test no_nulls_in_columns(model, columns) %}

{% for col in columns %}
select
    '{{ col }}' as column_name,
    count(*) as null_count
from {{ model }}
where {{ col }} is null
having count(*) > 0
{% if not loop.last %}union all{% endif %}
{% endfor %}

{% endtest %}
