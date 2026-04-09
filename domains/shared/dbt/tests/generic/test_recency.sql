{#
    Generic test: Assert that the most recent record is within N hours.
    Catches stale data / failed pipeline runs.

    Usage in schema.yml:
        tests:
          - recency:
              timestamp_column: _dbt_loaded_at
              max_hours: 24
#}

{% test recency(model, timestamp_column, max_hours) %}

select
    max({{ timestamp_column }}) as most_recent,
    current_timestamp() as checked_at,
    timestampdiff(HOUR, max({{ timestamp_column }}), current_timestamp()) as hours_since_last
from {{ model }}
having timestampdiff(HOUR, max({{ timestamp_column }}), current_timestamp()) > {{ max_hours }}

{% endtest %}
