{{ config(
    materialized='incremental',
    unique_key='volume_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'mail_volume', 'cleaned'],
    on_schema_change='fail'
) }}

/*
    Silver Layer: Mail Volume (Cleansed & Conformed)
    Description: Cleansed daily mail volume data with year-over-year comparisons,
                 business-day adjustments, and seasonal indicators. Provides
                 the foundation for volume forecasting and capacity planning.

    Transformations:
      - Product class standardization
      - Business day adjustment for volume comparison
      - Year-over-year volume change calculation
      - Seasonal period tagging (holiday, tax season, election, etc.)
      - Revenue per piece calculation
      - 7-day and 30-day moving averages
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_mail_volume') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|', facility_id, product_class, CAST(volume_date AS STRING))) AS volume_sk,

        -- Identifiers
        facility_id,
        UPPER(TRIM(facility_name)) AS facility_name,
        UPPER(TRIM(facility_type)) AS facility_type,
        UPPER(TRIM(district)) AS district,
        UPPER(TRIM(region)) AS region,
        UPPER(TRIM(state)) AS state,

        -- Product class standardization
        CASE UPPER(TRIM(product_class))
            WHEN 'FC' THEN 'FIRST_CLASS'
            WHEN 'FIRST CLASS' THEN 'FIRST_CLASS'
            WHEN 'FIRST_CLASS' THEN 'FIRST_CLASS'
            WHEN 'PM' THEN 'PRIORITY'
            WHEN 'PRIORITY' THEN 'PRIORITY'
            WHEN 'PME' THEN 'PRIORITY_EXPRESS'
            WHEN 'PRIORITY EXPRESS' THEN 'PRIORITY_EXPRESS'
            WHEN 'PS' THEN 'PARCEL_SELECT'
            WHEN 'PARCEL SELECT' THEN 'PARCEL_SELECT'
            WHEN 'MM' THEN 'MEDIA_MAIL'
            WHEN 'MEDIA MAIL' THEN 'MEDIA_MAIL'
            WHEN 'MKT' THEN 'MARKETING_MAIL'
            WHEN 'MARKETING MAIL' THEN 'MARKETING_MAIL'
            WHEN 'PER' THEN 'PERIODICALS'
            ELSE UPPER(TRIM(product_class))
        END AS product_class,

        mail_shape,

        -- Temporal
        volume_date,
        volume_year,
        volume_month,
        volume_day_of_week,
        COALESCE(is_business_day, CASE WHEN DAYOFWEEK(volume_date) IN (1, 7) THEN FALSE ELSE TRUE END) AS is_business_day,
        COALESCE(is_holiday, FALSE) AS is_holiday,

        -- Seasonal period tagging
        CASE
            WHEN volume_month = 12 OR (volume_month = 11 AND DAY(volume_date) >= 20) THEN 'HOLIDAY_PEAK'
            WHEN volume_month IN (1, 2) AND DAY(volume_date) <= 20 THEN 'POST_HOLIDAY'
            WHEN volume_month = 2 AND DAY(volume_date) BETWEEN 7 AND 14 THEN 'VALENTINES'
            WHEN volume_month IN (3, 4) THEN 'TAX_SEASON'
            WHEN volume_month = 5 AND DAY(volume_date) <= 14 THEN 'MOTHERS_DAY'
            WHEN volume_month IN (6, 7, 8) THEN 'SUMMER'
            WHEN volume_month = 10 THEN 'ELECTION_SEASON'
            ELSE 'REGULAR'
        END AS seasonal_period,

        -- Is peak season flag
        CASE
            WHEN volume_month IN (11, 12) THEN TRUE
            WHEN volume_month IN (3, 4) THEN TRUE  -- Tax season
            ELSE FALSE
        END AS is_peak_season,

        -- Volume metrics
        COALESCE(inbound_pieces, 0) AS inbound_pieces,
        COALESCE(outbound_pieces, 0) AS outbound_pieces,
        COALESCE(total_pieces, COALESCE(inbound_pieces, 0) + COALESCE(outbound_pieces, 0)) AS total_pieces,
        revenue_pieces,

        -- Weight
        total_weight_lbs,
        avg_weight_per_piece_oz,

        -- Revenue
        postage_revenue,
        avg_revenue_per_piece,

        -- Calculated revenue per piece if not provided
        CASE
            WHEN avg_revenue_per_piece IS NOT NULL THEN avg_revenue_per_piece
            WHEN total_pieces IS NOT NULL AND total_pieces > 0
                 AND postage_revenue IS NOT NULL
            THEN ROUND(postage_revenue / total_pieces, 4)
            ELSE NULL
        END AS calculated_revenue_per_piece,

        -- Year-over-year comparison
        volume_prior_year_same_day,

        -- YoY volume change
        CASE
            WHEN volume_prior_year_same_day IS NOT NULL AND volume_prior_year_same_day > 0
                 AND total_pieces IS NOT NULL
            THEN ROUND(
                (CAST(total_pieces AS DECIMAL(18, 4)) - volume_prior_year_same_day) * 100.0
                / volume_prior_year_same_day
            , 2)
            ELSE NULL
        END AS volume_yoy_change_pct,

        -- Week-over-week comparison
        volume_prior_week,

        CASE
            WHEN volume_prior_week IS NOT NULL AND volume_prior_week > 0
                 AND total_pieces IS NOT NULL
            THEN ROUND(
                (CAST(total_pieces AS DECIMAL(18, 4)) - volume_prior_week) * 100.0
                / volume_prior_week
            , 2)
            ELSE NULL
        END AS volume_wow_change_pct,

        -- Source tracking
        source_system,
        record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
),

-- Add moving averages with window functions
enriched AS (
    SELECT
        s.*,

        -- 7-day moving average
        ROUND(AVG(total_pieces) OVER (
            PARTITION BY facility_id, product_class
            ORDER BY volume_date
            ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
        ), 0) AS volume_7day_avg,

        -- 30-day moving average
        ROUND(AVG(total_pieces) OVER (
            PARTITION BY facility_id, product_class
            ORDER BY volume_date
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ), 0) AS volume_30day_avg,

        -- Standard deviation for anomaly detection
        STDDEV(total_pieces) OVER (
            PARTITION BY facility_id, product_class
            ORDER BY volume_date
            ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
        ) AS volume_30day_stddev,

        -- Anomaly flag (>3 std from 30-day average)
        CASE
            WHEN ABS(total_pieces - AVG(total_pieces) OVER (
                PARTITION BY facility_id, product_class
                ORDER BY volume_date
                ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
            )) > 3 * NULLIF(STDDEV(total_pieces) OVER (
                PARTITION BY facility_id, product_class
                ORDER BY volume_date
                ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
            ), 0)
            THEN TRUE
            ELSE FALSE
        END AS is_volume_anomaly

    FROM standardized s
)

SELECT * FROM enriched
