{{ config(
    materialized='incremental',
    unique_key='gdp_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'bea', 'gdp', 'cleaned']
) }}

{#
    Silver Layer: Normalized GDP with Inflation Adjustment and Per-Capita Calculations

    Transforms raw BEA GDP data into standardized, analytics-ready format.

    Key transformations:
    1. GDP deflation to constant (chained {{ var('gdp_base_year') }}) dollars
    2. Per-capita GDP calculation using Census population estimates
    3. NAICS sector standardization and validation
    4. Annualized quarterly GDP conversion
    5. GDP component share calculations
    6. Year-over-year growth rate computation

    BEA GDP methodology notes:
    - State GDP is measured as the sum of value added by all industries
    - Value added = compensation + taxes on production - subsidies + gross operating surplus
    - Chained dollars use Fisher chain-weighted methodology (not simple deflation)
    - Quarterly GDP is reported at seasonally adjusted annual rates (SAAR)
#}

WITH base AS (
    SELECT * FROM {{ ref('brz_gdp_data') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Standardize NAICS sectors and add industry labels
standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            state_fips,
            COALESCE(naics_sector, 'ALL'),
            CAST(year AS STRING),
            CAST(quarter AS STRING)
        )) AS gdp_sk,

        -- Geography
        state_fips,
        UPPER(TRIM(state_name)) AS state_name,
        region_code,
        UPPER(TRIM(region_name)) AS region_name,

        -- Time dimension
        year,
        quarter,
        year_quarter,

        -- Industry classification with standardization
        COALESCE(naics_sector, 'ALL') AS naics_sector,
        CASE
            WHEN naics_sector = '11' THEN 'Agriculture, Forestry, Fishing'
            WHEN naics_sector = '21' THEN 'Mining, Quarrying, Oil/Gas'
            WHEN naics_sector = '22' THEN 'Utilities'
            WHEN naics_sector = '23' THEN 'Construction'
            WHEN naics_sector IN ('31-33', '31', '32', '33') THEN 'Manufacturing'
            WHEN naics_sector = '42' THEN 'Wholesale Trade'
            WHEN naics_sector IN ('44-45', '44', '45') THEN 'Retail Trade'
            WHEN naics_sector IN ('48-49', '48', '49') THEN 'Transportation & Warehousing'
            WHEN naics_sector = '51' THEN 'Information'
            WHEN naics_sector = '52' THEN 'Finance & Insurance'
            WHEN naics_sector = '53' THEN 'Real Estate'
            WHEN naics_sector = '54' THEN 'Professional & Technical Services'
            WHEN naics_sector = '55' THEN 'Management of Companies'
            WHEN naics_sector = '56' THEN 'Administrative & Waste Services'
            WHEN naics_sector = '61' THEN 'Educational Services'
            WHEN naics_sector = '62' THEN 'Health Care & Social Assistance'
            WHEN naics_sector = '71' THEN 'Arts, Entertainment, Recreation'
            WHEN naics_sector = '72' THEN 'Accommodation & Food Services'
            WHEN naics_sector = '81' THEN 'Other Services'
            WHEN naics_sector = '92' THEN 'Government'
            WHEN naics_sector = 'ALL' THEN 'All Industries'
            ELSE COALESCE(industry_name, 'Unknown')
        END AS industry_name,

        -- GDP values (millions of dollars)
        ROUND(gdp_current_dollars, 2) AS gdp_current_dollars,
        ROUND(gdp_chained_dollars, 2) AS gdp_chained_dollars,

        -- Real GDP: prefer chained dollars, fall back to deflation
        ROUND(
            COALESCE(
                gdp_chained_dollars,
                CASE
                    WHEN price_index > 0
                    THEN gdp_current_dollars / (price_index / 100.0)
                    ELSE NULL
                END
            ), 2
        ) AS gdp_real_dollars,

        -- GDP components
        ROUND(personal_income, 2) AS personal_income,
        ROUND(compensation, 2) AS compensation,
        ROUND(COALESCE(taxes_on_production, 0) - COALESCE(subsidies, 0), 2)
            AS net_taxes_on_production,
        ROUND(gross_operating_surplus, 2) AS gross_operating_surplus,

        -- Price and quantity indices
        ROUND(price_index, 4) AS price_index,
        ROUND(quantity_index, 4) AS quantity_index,

        -- Implicit price deflator (current / real * 100)
        CASE
            WHEN gdp_chained_dollars > 0
            THEN ROUND(gdp_current_dollars / gdp_chained_dollars * 100, 4)
            ELSE price_index
        END AS implicit_price_deflator,

        is_seasonally_adjusted,
        estimate_type,

        -- Previous period GDP for growth calculation (window function)
        LAG(gdp_chained_dollars, 1) OVER (
            PARTITION BY state_fips, naics_sector
            ORDER BY year, quarter
        ) AS prev_quarter_gdp_real,

        LAG(gdp_chained_dollars, 4) OVER (
            PARTITION BY state_fips, naics_sector
            ORDER BY year, quarter
        ) AS prev_year_gdp_real,

        -- Data quality
        CASE
            WHEN gdp_current_dollars IS NULL AND gdp_chained_dollars IS NULL THEN FALSE
            WHEN gdp_current_dollars < 0 OR gdp_chained_dollars < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid,

        CASE
            WHEN gdp_current_dollars IS NULL AND gdp_chained_dollars IS NULL
                THEN 'Missing all GDP values'
            WHEN gdp_current_dollars < 0 OR gdp_chained_dollars < 0
                THEN 'Negative GDP value'
            ELSE NULL
        END AS validation_errors,

        -- Metadata
        'BEA_GDP' AS source_system,
        load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
),

-- Add growth rate calculations
with_growth AS (
    SELECT
        *,

        -- Quarter-over-quarter annualized growth rate
        -- Annualized = ((Q/Q-1)^4 - 1) * 100
        CASE
            WHEN prev_quarter_gdp_real > 0 AND gdp_real_dollars > 0
            THEN ROUND(
                (POWER(gdp_real_dollars / prev_quarter_gdp_real, 4) - 1) * 100, 2
            )
            ELSE NULL
        END AS gdp_growth_rate_qoq_annualized,

        -- Year-over-year growth rate
        CASE
            WHEN prev_year_gdp_real > 0 AND gdp_real_dollars > 0
            THEN ROUND(
                (gdp_real_dollars / prev_year_gdp_real - 1) * 100, 2
            )
            ELSE NULL
        END AS gdp_growth_rate_yoy,

        -- GDP share (industry as % of state total)
        CASE
            WHEN naics_sector != 'ALL'
            THEN gdp_current_dollars / NULLIF(
                SUM(CASE WHEN naics_sector = 'ALL' THEN gdp_current_dollars END)
                OVER (PARTITION BY state_fips, year, quarter), 0
            ) * 100
            ELSE 100.0
        END AS industry_gdp_share_pct

    FROM standardized
)

SELECT
    gdp_sk,
    state_fips,
    state_name,
    region_code,
    region_name,
    year,
    quarter,
    year_quarter,
    naics_sector,
    industry_name,
    gdp_current_dollars,
    gdp_chained_dollars,
    gdp_real_dollars,
    personal_income,
    compensation,
    net_taxes_on_production,
    gross_operating_surplus,
    price_index,
    quantity_index,
    implicit_price_deflator,
    is_seasonally_adjusted,
    estimate_type,
    ROUND(gdp_growth_rate_qoq_annualized, 2) AS gdp_growth_rate_qoq_annualized,
    ROUND(gdp_growth_rate_yoy, 2) AS gdp_growth_rate_yoy,
    ROUND(industry_gdp_share_pct, 2) AS industry_gdp_share_pct,
    is_valid,
    validation_errors,
    source_system,
    load_time,
    processed_timestamp,
    _dbt_loaded_at
FROM with_growth
WHERE is_valid = TRUE
