{{ '{{' }} config(
    materialized='table',
    tags=['gold', '{{ cookiecutter.vertical_slug }}', 'daily'],
) {{ '}}' }}

{{ '{#' }}
    Gold layer: daily aggregates per station + metric.
{{ '#}' }}

SELECT
    DATE(event_time_utc) AS report_date,
    station_id,
    metric_name,
    COUNT(*) AS observation_count,
    SUM(CASE WHEN is_valid THEN 1 ELSE 0 END) AS valid_count,
    AVG(CASE WHEN is_valid THEN value END) AS avg_value,
    MIN(CASE WHEN is_valid THEN value END) AS min_value,
    MAX(CASE WHEN is_valid THEN value END) AS max_value
FROM {{ '{{' }} ref('slv_observations_cleaned') {{ '}}' }}
GROUP BY 1, 2, 3
