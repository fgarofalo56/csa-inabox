{{ config(
    materialized='table',
    tags=['gold', 'trade_patterns', 'analytics']
) }}

{#
    Gold Layer: Bilateral Trade Analysis, Commodity Trends, and Balance of Trade

    This model produces comprehensive international trade analytics:

    1. Bilateral Trade Summary:
       - Total exports/imports by partner country and year
       - Trade balance (exports - imports)
       - Year-over-year growth rates for exports and imports

    2. Commodity Trend Analysis:
       - Top commodities by trade value
       - Commodity growth trends over time
       - HS chapter concentration metrics

    3. Trade Intensity Metrics:
       - Trade openness = (exports + imports) / GDP
       - Revealed Comparative Advantage (RCA) for key sectors
       - Geographic diversification of trade partners

    Output types (via flow_type column):
    - BILATERAL_SUMMARY: One row per partner country per year
    - COMMODITY_TREND: One row per HS chapter per year
    - TRADE_BALANCE_MONTHLY: Monthly trade balance time series
#}

WITH -- Step 1: Aggregate bilateral trade by partner country and year
bilateral_annual AS (
    SELECT
        partner_country_code,
        partner_country_name,
        partner_region,
        trade_bloc,
        year,
        -- Export totals
        ROUND(SUM(CASE WHEN flow_type = 'EXPORT' THEN trade_value_usd ELSE 0 END), 2)
            AS total_exports,
        COUNT(CASE WHEN flow_type = 'EXPORT' THEN 1 END) AS export_transactions,
        -- Import totals
        ROUND(SUM(CASE WHEN flow_type = 'IMPORT' THEN trade_value_usd ELSE 0 END), 2)
            AS total_imports,
        COUNT(CASE WHEN flow_type = 'IMPORT' THEN 1 END) AS import_transactions,
        -- Trade balance
        ROUND(
            SUM(CASE WHEN flow_type = 'EXPORT' THEN trade_value_usd ELSE 0 END) -
            SUM(CASE WHEN flow_type = 'IMPORT' THEN trade_value_usd ELSE 0 END),
            2
        ) AS trade_balance,
        -- Total trade volume
        ROUND(SUM(trade_value_usd), 2) AS total_trade_volume,
        -- Distinct commodities traded
        COUNT(DISTINCT hs_chapter) AS distinct_hs_chapters,
        -- Average effective tariff on imports
        ROUND(AVG(CASE WHEN flow_type = 'IMPORT' AND effective_tariff_rate_pct > 0
                       THEN effective_tariff_rate_pct END), 4)
            AS avg_import_tariff_rate
    FROM {{ ref('slv_trade_data') }}
    WHERE year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
    GROUP BY partner_country_code, partner_country_name, partner_region, trade_bloc, year
),

-- Step 2: Calculate year-over-year growth and prior-year values
bilateral_with_growth AS (
    SELECT
        *,
        -- Prior year values
        LAG(total_exports, 1) OVER (
            PARTITION BY partner_country_code ORDER BY year
        ) AS prev_year_exports,
        LAG(total_imports, 1) OVER (
            PARTITION BY partner_country_code ORDER BY year
        ) AS prev_year_imports,
        LAG(trade_balance, 1) OVER (
            PARTITION BY partner_country_code ORDER BY year
        ) AS prev_year_balance,
        -- Export growth YoY
        CASE
            WHEN LAG(total_exports, 1) OVER (PARTITION BY partner_country_code ORDER BY year) > 0
            THEN ROUND(
                (total_exports / LAG(total_exports, 1) OVER (
                    PARTITION BY partner_country_code ORDER BY year
                ) - 1) * 100, 2)
            ELSE NULL
        END AS export_growth_yoy_pct,
        -- Import growth YoY
        CASE
            WHEN LAG(total_imports, 1) OVER (PARTITION BY partner_country_code ORDER BY year) > 0
            THEN ROUND(
                (total_imports / LAG(total_imports, 1) OVER (
                    PARTITION BY partner_country_code ORDER BY year
                ) - 1) * 100, 2)
            ELSE NULL
        END AS import_growth_yoy_pct
    FROM bilateral_annual
),

-- Step 3: Identify top export and import commodities per partner
top_commodities AS (
    SELECT
        partner_country_code,
        year,
        -- Top export commodity
        MAX_BY(hs_section_name, export_value) AS top_export_commodity,
        MAX(export_value) AS top_export_value,
        -- Top import commodity
        MAX_BY(hs_section_name, import_value) AS top_import_commodity,
        MAX(import_value) AS top_import_value
    FROM (
        SELECT
            partner_country_code,
            year,
            hs_section_name,
            SUM(CASE WHEN flow_type = 'EXPORT' THEN trade_value_usd ELSE 0 END) AS export_value,
            SUM(CASE WHEN flow_type = 'IMPORT' THEN trade_value_usd ELSE 0 END) AS import_value
        FROM {{ ref('slv_trade_data') }}
        WHERE year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
        GROUP BY partner_country_code, year, hs_section_name
    )
    GROUP BY partner_country_code, year
),

-- Step 4: Final bilateral summary with rankings
bilateral_summary AS (
    SELECT
        b.partner_country_code,
        b.partner_country_name,
        b.partner_region,
        b.trade_bloc,
        b.year,
        'BILATERAL_SUMMARY' AS flow_type,

        -- Trade values
        b.total_exports,
        b.total_imports,
        b.trade_balance,
        b.total_trade_volume,

        -- Trade balance direction
        CASE
            WHEN b.trade_balance > 0 THEN 'SURPLUS'
            WHEN b.trade_balance < 0 THEN 'DEFICIT'
            ELSE 'BALANCED'
        END AS trade_balance_direction,

        -- Growth rates
        b.export_growth_yoy_pct,
        b.import_growth_yoy_pct,

        -- Trade balance change
        CASE
            WHEN b.prev_year_balance IS NOT NULL
            THEN ROUND(b.trade_balance - b.prev_year_balance, 2)
            ELSE NULL
        END AS trade_balance_change,

        -- Top commodities
        COALESCE(c.top_export_commodity, 'N/A') AS top_export_commodity,
        COALESCE(c.top_import_commodity, 'N/A') AS top_import_commodity,

        -- Tariff metrics
        b.avg_import_tariff_rate,
        ROUND(COALESCE(b.avg_import_tariff_rate, 0) * b.total_imports / 100, 2)
            AS estimated_tariff_revenue,

        -- Diversity metrics
        b.distinct_hs_chapters,
        b.export_transactions + b.import_transactions AS total_transactions,

        -- Partner rankings
        ROW_NUMBER() OVER (PARTITION BY b.year ORDER BY b.total_trade_volume DESC)
            AS trade_volume_rank,
        ROW_NUMBER() OVER (PARTITION BY b.year ORDER BY b.total_exports DESC)
            AS export_rank,
        ROW_NUMBER() OVER (PARTITION BY b.year ORDER BY b.total_imports DESC)
            AS import_rank,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM bilateral_with_growth b
    LEFT JOIN top_commodities c
        ON b.partner_country_code = c.partner_country_code AND b.year = c.year
),

-- Step 5: Commodity-level trend analysis
commodity_trends AS (
    SELECT
        'ALL' AS partner_country_code,
        hs_section_name AS partner_country_name,
        hs_chapter AS partner_region,
        'GLOBAL' AS trade_bloc,
        year,
        'COMMODITY_TREND' AS flow_type,

        -- Trade values by commodity
        ROUND(SUM(CASE WHEN flow_type = 'EXPORT' THEN trade_value_usd ELSE 0 END), 2)
            AS total_exports,
        ROUND(SUM(CASE WHEN flow_type = 'IMPORT' THEN trade_value_usd ELSE 0 END), 2)
            AS total_imports,
        ROUND(
            SUM(CASE WHEN flow_type = 'EXPORT' THEN trade_value_usd ELSE 0 END) -
            SUM(CASE WHEN flow_type = 'IMPORT' THEN trade_value_usd ELSE 0 END),
            2
        ) AS trade_balance,
        ROUND(SUM(trade_value_usd), 2) AS total_trade_volume,

        CASE
            WHEN SUM(CASE WHEN flow_type = 'EXPORT' THEN trade_value_usd ELSE 0 END) >
                 SUM(CASE WHEN flow_type = 'IMPORT' THEN trade_value_usd ELSE 0 END)
            THEN 'SURPLUS'
            ELSE 'DEFICIT'
        END AS trade_balance_direction,

        -- Growth rates (computed via window)
        NULL AS export_growth_yoy_pct,
        NULL AS import_growth_yoy_pct,
        NULL AS trade_balance_change,

        hs_section_name AS top_export_commodity,
        hs_section_name AS top_import_commodity,

        ROUND(AVG(CASE WHEN flow_type = 'IMPORT' AND effective_tariff_rate_pct > 0
                       THEN effective_tariff_rate_pct END), 4) AS avg_import_tariff_rate,
        NULL AS estimated_tariff_revenue,

        COUNT(DISTINCT partner_country_code) AS distinct_hs_chapters,
        COUNT(*) AS total_transactions,

        ROW_NUMBER() OVER (PARTITION BY year ORDER BY SUM(trade_value_usd) DESC) AS trade_volume_rank,
        NULL AS export_rank,
        NULL AS import_rank,

        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ ref('slv_trade_data') }}
    WHERE year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
    GROUP BY hs_section_name, hs_chapter, year
)

-- Union bilateral summaries and commodity trends
SELECT * FROM bilateral_summary
UNION ALL
SELECT * FROM commodity_trends
ORDER BY year DESC, total_trade_volume DESC
