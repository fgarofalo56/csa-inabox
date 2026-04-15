{{ config(
    materialized='incremental',
    unique_key='visitor_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'nps', 'visitors', 'parks', 'cleaned'],
    on_schema_change='fail'
) }}

{#
    Silver Layer: Standardized Visitor Data with Seasonality Flags and Capacity Utilization

    Transforms raw NPS visitor statistics into analytics-ready format.

    Key transformations:
    1. Seasonality classification (peak, shoulder, off-peak)
    2. Capacity utilization calculation against design capacity
    3. Year-over-year growth rate computation
    4. Visitor density metrics (visitors per acre, per mile of trail)
    5. COVID-19 impact flagging (2020-2021 anomaly detection)
    6. Rolling averages for trend smoothing

    NPS visit counting methodology:
    - "Recreation visit" = entry of a person onto lands/waters for recreation
    - Counted at entrance stations, with vehicle multiplier
    - Some parks use traffic counters with seasonal calibration
    - Backcountry visits estimated from permits
#}

WITH base AS (
    SELECT * FROM {{ ref('brz_park_visitors') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

enriched AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            park_code,
            CAST(year AS STRING),
            CAST(month AS STRING)
        )) AS visitor_sk,

        -- Park identification
        park_code,
        park_name,
        park_type,
        state,
        region,

        -- Time dimension
        year,
        month,
        DATE(CONCAT(year, '-', LPAD(CAST(month AS STRING), 2, '0'), '-01')) AS visit_month_date,

        -- Seasonality classification
        CASE
            WHEN month IN ({{ var('peak_season_months') | join(', ') }})
                THEN 'PEAK'
            WHEN month IN ({{ var('shoulder_season_months') | join(', ') }})
                THEN 'SHOULDER'
            ELSE 'OFF_PEAK'
        END AS season_type,

        -- Visitor counts
        recreation_visits,
        COALESCE(non_recreation_visits, 0) AS non_recreation_visits,
        recreation_visits + COALESCE(non_recreation_visits, 0) AS total_visits,
        COALESCE(recreation_hours, 0) AS recreation_hours,

        -- Camping metrics
        COALESCE(tent_campers, 0) AS tent_campers,
        COALESCE(rv_campers, 0) AS rv_campers,
        COALESCE(backcountry_campers, 0) AS backcountry_campers,
        COALESCE(tent_campers, 0) + COALESCE(rv_campers, 0)
            + COALESCE(backcountry_campers, 0) AS total_campers,
        COALESCE(concessioner_lodging, 0) AS concessioner_lodging,

        -- Park characteristics
        park_acres,
        trail_miles,
        campground_capacity,
        parking_spaces,

        -- Visitor density (visitors per 1000 acres)
        CASE
            WHEN park_acres > 0
            THEN ROUND(recreation_visits / (park_acres / 1000.0), 2)
            ELSE NULL
        END AS visitors_per_1000_acres,

        -- Capacity utilization (monthly visits vs capacity proxy)
        -- Capacity proxy: campground * 30 days * 2.5 turnover + parking * 30 * 3 turnover
        CASE
            WHEN COALESCE(campground_capacity, 0) + COALESCE(parking_spaces, 0) > 0
            THEN ROUND(
                recreation_visits / (
                    COALESCE(campground_capacity, 0) * 30 * 2.5
                    + COALESCE(parking_spaces, 0) * 30 * 3.0
                ) * 100, 2
            )
            ELSE NULL
        END AS capacity_utilization_pct,

        -- Average length of stay (hours per visit)
        CASE
            WHEN recreation_visits > 0 AND recreation_hours > 0
            THEN ROUND(recreation_hours / recreation_visits, 1)
            ELSE NULL
        END AS avg_hours_per_visit,

        -- Campground fill rate
        CASE
            WHEN campground_capacity > 0
            THEN ROUND(
                (COALESCE(tent_campers, 0) + COALESCE(rv_campers, 0))
                / (campground_capacity * 30.0) * 100, 2
            )
            ELSE NULL
        END AS campground_fill_rate_pct,

        -- Year-over-year growth
        LAG(recreation_visits, 12) OVER (
            PARTITION BY park_code ORDER BY year, month
        ) AS prev_year_same_month_visits,

        -- Rolling 12-month average
        AVG(recreation_visits) OVER (
            PARTITION BY park_code
            ORDER BY year, month
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) AS rolling_12mo_avg_visits,

        -- COVID impact flag
        CASE
            WHEN year = 2020 AND month BETWEEN 3 AND 12 THEN TRUE
            WHEN year = 2021 AND month BETWEEN 1 AND 6 THEN TRUE
            ELSE FALSE
        END AS is_covid_impacted,

        -- Anomaly detection: visits deviating >2 std from rolling average
        CASE
            WHEN ABS(recreation_visits - AVG(recreation_visits) OVER (
                PARTITION BY park_code, month
                ORDER BY year
                ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING
            )) / NULLIF(STDDEV(recreation_visits) OVER (
                PARTITION BY park_code, month
                ORDER BY year
                ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING
            ), 0) > 2.0 THEN TRUE
            ELSE FALSE
        END AS is_visit_anomaly,

        -- Data quality
        CASE
            WHEN recreation_visits >= 0 AND year >= 2000 THEN TRUE
            ELSE FALSE
        END AS is_valid,

        CASE
            WHEN recreation_visits < 0 THEN 'Negative visitor count'
            WHEN year < 2000 THEN 'Historical data before 2000'
            ELSE NULL
        END AS validation_errors,

        -- Metadata
        'NPS_STATS' AS source_system,
        load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
),

with_growth AS (
    SELECT
        *,
        -- YoY growth rate
        CASE
            WHEN prev_year_same_month_visits > 0
            THEN ROUND(
                (recreation_visits - prev_year_same_month_visits)
                / prev_year_same_month_visits::DECIMAL * 100, 2
            )
            ELSE NULL
        END AS yoy_growth_rate
    FROM enriched
)

SELECT * FROM with_growth
WHERE is_valid = TRUE
