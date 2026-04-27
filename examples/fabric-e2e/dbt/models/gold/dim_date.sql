{{ config(materialized='table') }}
-- Static date dimension 2020-01-01 → 2030-12-31. Replace with your DB's date generator.
WITH RECURSIVE dates AS (
    SELECT DATE '2020-01-01' AS d
    UNION ALL
    SELECT d + INTERVAL 1 DAY FROM dates WHERE d < DATE '2030-12-31'
)
SELECT
    CAST(strftime(d, '%Y%m%d') AS BIGINT) AS date_key,
    d AS date,
    EXTRACT(YEAR FROM d) AS year,
    EXTRACT(QUARTER FROM d) AS quarter,
    EXTRACT(MONTH FROM d) AS month,
    strftime(d, '%B') AS month_name,
    EXTRACT(DOW FROM d) AS day_of_week,
    EXTRACT(DOW FROM d) IN (0, 6) AS is_weekend,
    FALSE AS is_holiday   -- override via reference data
FROM dates
