{{ config(
    materialized='table',
    tags=['gold', 'volume', 'forecast', 'analytics']
) }}

/*
    Gold Layer: Volume Forecast
    Description: Mail and parcel volume forecasting by product class and region.
                 Uses historical patterns with seasonal decomposition, year-over-year
                 growth trends, and peak season identification to predict future
                 volumes and recommend staffing adjustments.

    Business Use Cases:
      - Pre-position resources for holiday/tax peak seasons
      - Budget and staffing level forecasting by district
      - Capacity planning for processing facilities
      - Identify product class trends (letter decline, parcel growth)
*/

WITH volume_base AS (
    SELECT
        region,
        district,
        state,
        product_class,
        volume_date,
        volume_year,
        volume_month,
        is_business_day,
        is_holiday,
        seasonal_period,
        is_peak_season,
        total_pieces,
        postage_revenue,
        calculated_revenue_per_piece,
        volume_yoy_change_pct,
        volume_7day_avg,
        volume_30day_avg,
        volume_30day_stddev,
        is_volume_anomaly
    FROM {{ ref('slv_mail_volume') }}
    WHERE volume_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years') }}
),

-- Monthly aggregation by region and product class
monthly_volume AS (
    SELECT
        region,
        product_class,
        volume_year,
        volume_month,
        TRY_CAST(CONCAT(volume_year, '-', LPAD(volume_month, 2, '0'), '-01') AS DATE) AS month_start,

        -- Volume metrics
        SUM(total_pieces) AS total_volume,
        SUM(CASE WHEN is_business_day THEN total_pieces ELSE 0 END) AS business_day_volume,
        COUNT(DISTINCT CASE WHEN is_business_day THEN volume_date END) AS business_days,

        -- Business-day-adjusted daily average
        CASE
            WHEN COUNT(DISTINCT CASE WHEN is_business_day THEN volume_date END) > 0
            THEN ROUND(
                SUM(CASE WHEN is_business_day THEN total_pieces ELSE 0 END)::DECIMAL
                / COUNT(DISTINCT CASE WHEN is_business_day THEN volume_date END)
            , 0)
            ELSE NULL
        END AS avg_daily_volume_business_days,

        -- Revenue
        SUM(COALESCE(postage_revenue, 0)) AS total_revenue,

        -- Seasonal characteristics
        MODE(seasonal_period) AS primary_seasonal_period,
        MAX(CAST(is_peak_season AS INT)) AS is_peak_month,

        -- Anomaly count
        SUM(CASE WHEN is_volume_anomaly THEN 1 ELSE 0 END) AS anomaly_days,

        -- Average 30-day moving average (for trend reference)
        AVG(volume_30day_avg) AS avg_30day_moving_avg

    FROM volume_base
    GROUP BY region, product_class, volume_year, volume_month
),

-- Year-over-year trend analysis
with_trends AS (
    SELECT
        mv.*,

        -- Previous year same month
        LAG(total_volume, 12) OVER (
            PARTITION BY region, product_class
            ORDER BY volume_year, volume_month
        ) AS volume_prev_year,

        -- Year-over-year change
        CASE
            WHEN LAG(total_volume, 12) OVER (
                PARTITION BY region, product_class
                ORDER BY volume_year, volume_month
            ) IS NOT NULL AND LAG(total_volume, 12) OVER (
                PARTITION BY region, product_class
                ORDER BY volume_year, volume_month
            ) > 0
            THEN ROUND(
                (total_volume - LAG(total_volume, 12) OVER (
                    PARTITION BY region, product_class
                    ORDER BY volume_year, volume_month
                )) * 100.0 / LAG(total_volume, 12) OVER (
                    PARTITION BY region, product_class
                    ORDER BY volume_year, volume_month
                )
            , 2)
            ELSE NULL
        END AS yoy_growth_pct,

        -- 12-month rolling total
        SUM(total_volume) OVER (
            PARTITION BY region, product_class
            ORDER BY volume_year, volume_month
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) AS rolling_12m_volume,

        -- Previous 12-month rolling total
        SUM(total_volume) OVER (
            PARTITION BY region, product_class
            ORDER BY volume_year, volume_month
            ROWS BETWEEN 23 PRECEDING AND 12 PRECEDING
        ) AS rolling_12m_volume_prev,

        -- 3-month moving average (for smoothed trend)
        AVG(total_volume) OVER (
            PARTITION BY region, product_class
            ORDER BY volume_year, volume_month
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) AS volume_3m_avg,

        -- Linear trend slope over 12 months
        REGR_SLOPE(total_volume, volume_month + (volume_year * 12)) OVER (
            PARTITION BY region, product_class
            ORDER BY volume_year, volume_month
            ROWS BETWEEN 11 PRECEDING AND CURRENT ROW
        ) AS volume_12m_trend_slope

    FROM monthly_volume mv
),

-- Generate simple forecast and recommendations
forecast AS (
    SELECT
        wt.*,

        -- Simple forecast: 3-month average + trend adjustment
        CASE
            WHEN volume_3m_avg IS NOT NULL AND volume_12m_trend_slope IS NOT NULL
            THEN ROUND(volume_3m_avg + (volume_12m_trend_slope * 3), 0)  -- 3 months ahead
            WHEN volume_3m_avg IS NOT NULL
            THEN ROUND(volume_3m_avg, 0)
            ELSE total_volume
        END AS predicted_volume_next_quarter,

        -- Forecast bounds (based on historical variability)
        CASE
            WHEN volume_3m_avg IS NOT NULL
            THEN ROUND(volume_3m_avg * 0.85, 0)  -- Lower bound (~85%)
            ELSE NULL
        END AS lower_bound_95,

        CASE
            WHEN volume_3m_avg IS NOT NULL
            THEN ROUND(volume_3m_avg * 1.15, 0)  -- Upper bound (~115%)
            ELSE NULL
        END AS upper_bound_95,

        -- Volume trend classification
        CASE
            WHEN rolling_12m_volume_prev IS NULL THEN 'INSUFFICIENT_DATA'
            WHEN rolling_12m_volume > rolling_12m_volume_prev * 1.05 THEN 'GROWING'
            WHEN rolling_12m_volume < rolling_12m_volume_prev * 0.95 THEN 'DECLINING'
            ELSE 'STABLE'
        END AS volume_trend,

        -- Staffing recommendation based on forecast vs. current capacity
        CASE
            WHEN is_peak_month = 1 AND yoy_growth_pct > 5 THEN 'INCREASE_STAFFING'
            WHEN yoy_growth_pct > 10 THEN 'INCREASE_STAFFING'
            WHEN yoy_growth_pct < -10 THEN 'REDUCE_STAFFING'
            WHEN is_peak_month = 1 THEN 'SEASONAL_SURGE_STAFFING'
            ELSE 'MAINTAIN_STAFFING'
        END AS recommended_staffing_action,

        -- Peak season flag for upcoming months
        CASE
            WHEN volume_month IN (11, 12) THEN TRUE
            WHEN volume_month IN (3, 4) THEN TRUE
            ELSE FALSE
        END AS peak_season_flag

    FROM with_trends wt
),

-- Final output
final AS (
    SELECT
        -- Identifiers
        region,
        product_class,
        volume_year,
        volume_month,
        month_start AS forecast_month,

        -- Actual volumes
        total_volume,
        business_day_volume,
        business_days,
        avg_daily_volume_business_days,

        -- Revenue
        total_revenue,

        -- Seasonal
        primary_seasonal_period,
        peak_season_flag,

        -- Trends
        volume_prev_year,
        yoy_growth_pct,
        volume_trend,
        ROUND(volume_3m_avg, 0) AS volume_3m_avg,
        rolling_12m_volume,

        -- Forecast
        predicted_volume_next_quarter AS predicted_volume,
        lower_bound_95,
        upper_bound_95,
        'LINEAR_TREND_SEASONAL' AS forecast_method,

        -- Recommendations
        recommended_staffing_action,

        -- Staffing delta estimate (percent change needed)
        CASE
            WHEN recommended_staffing_action = 'INCREASE_STAFFING'
            THEN ROUND(GREATEST(COALESCE(yoy_growth_pct, 0), 5), 0)
            WHEN recommended_staffing_action = 'REDUCE_STAFFING'
            THEN ROUND(LEAST(COALESCE(yoy_growth_pct, 0), -5), 0)
            WHEN recommended_staffing_action = 'SEASONAL_SURGE_STAFFING'
            THEN 15  -- Default 15% seasonal surge
            ELSE 0
        END AS recommended_staffing_delta_pct,

        -- Data quality
        anomaly_days,
        CASE WHEN anomaly_days <= 2 THEN TRUE ELSE FALSE END AS is_forecast_reliable,

        -- Rankings
        ROW_NUMBER() OVER (
            PARTITION BY product_class, volume_year, volume_month
            ORDER BY total_volume DESC
        ) AS region_volume_rank,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM forecast
)

SELECT * FROM final
ORDER BY product_class, region, volume_year DESC, volume_month DESC
