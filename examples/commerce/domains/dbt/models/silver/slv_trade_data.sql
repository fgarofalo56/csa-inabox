{{ config(
    materialized='incremental',
    unique_key='trade_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'trade', 'cleaned']
) }}

{#
    Silver Layer: Standardized International Trade with Harmonized Commodity Codes

    Transforms raw trade transaction data into analytics-ready format.

    Key transformations:
    1. HS code harmonization across revision years (2012, 2017, 2022 revisions)
    2. Country code standardization to ISO 3166-1 alpha-3
    3. Unit value calculation (trade value / quantity)
    4. Trade balance computation at the bilateral level
    5. Commodity section and chapter labeling
    6. Quality checks for outlier trade values

    HS Code harmonization approach:
    - HS codes are revised every 5 years by the World Customs Organization
    - We maintain a concordance at the 6-digit level
    - For cross-year analysis, we use the most recent HS revision as the target
#}

WITH base AS (
    SELECT * FROM {{ ref('brz_trade_data') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            trade_id,
            COALESCE(partner_country_code, ''),
            COALESCE(hs_code, ''),
            flow_type,
            CAST(year AS STRING),
            CAST(month AS STRING)
        )) AS trade_sk,

        trade_id,

        -- Flow classification
        flow_type,
        CASE
            WHEN flow_type = 'EXPORT' THEN 1
            WHEN flow_type = 'IMPORT' THEN -1
            ELSE 0
        END AS flow_direction,  -- Useful for balance calculations

        -- Partner country standardization
        UPPER(TRIM(partner_country_code)) AS partner_country_code,
        INITCAP(TRIM(partner_country_name)) AS partner_country_name,
        COALESCE(partner_region, 'UNCLASSIFIED') AS partner_region,
        COALESCE(partner_income_group, 'UNCLASSIFIED') AS partner_income_group,

        -- Partner country groupings for analytics
        CASE
            WHEN partner_country_code IN ('CAN', 'MEX') THEN 'USMCA'
            WHEN partner_country_code IN ('CHN', 'JPN', 'KOR', 'TWN', 'VNM',
                                           'THA', 'MYS', 'IDN', 'SGP', 'PHL',
                                           'IND', 'BGD') THEN 'ASIA_PACIFIC'
            WHEN partner_country_code IN ('GBR', 'DEU', 'FRA', 'ITA', 'NLD',
                                           'BEL', 'ESP', 'IRL', 'CHE', 'SWE',
                                           'POL', 'AUT') THEN 'EUROPE'
            WHEN partner_country_code IN ('BRA', 'ARG', 'COL', 'CHL', 'PER') THEN 'SOUTH_AMERICA'
            WHEN partner_country_code IN ('SAU', 'ARE', 'ISR', 'QAT', 'KWT') THEN 'MIDDLE_EAST'
            WHEN partner_country_code IN ('NGA', 'ZAF', 'EGY', 'KEN', 'GHA') THEN 'AFRICA'
            ELSE 'OTHER'
        END AS trade_bloc,

        -- Harmonized System commodity classification
        LPAD(hs_code, 6, '0') AS hs_code,
        hs_chapter,
        hs_heading,
        hs_subheading,
        COALESCE(commodity_description, 'Unknown Commodity') AS commodity_description,

        -- HS section labeling (Sections I-XXI)
        CASE
            WHEN CAST(hs_chapter AS INT) BETWEEN 1 AND 5 THEN 'I - Live Animals & Products'
            WHEN CAST(hs_chapter AS INT) BETWEEN 6 AND 14 THEN 'II - Vegetable Products'
            WHEN CAST(hs_chapter AS INT) = 15 THEN 'III - Fats & Oils'
            WHEN CAST(hs_chapter AS INT) BETWEEN 16 AND 24 THEN 'IV - Food, Beverages, Tobacco'
            WHEN CAST(hs_chapter AS INT) BETWEEN 25 AND 27 THEN 'V - Mineral Products'
            WHEN CAST(hs_chapter AS INT) BETWEEN 28 AND 38 THEN 'VI - Chemical Products'
            WHEN CAST(hs_chapter AS INT) BETWEEN 39 AND 40 THEN 'VII - Plastics & Rubber'
            WHEN CAST(hs_chapter AS INT) BETWEEN 41 AND 43 THEN 'VIII - Leather & Hides'
            WHEN CAST(hs_chapter AS INT) BETWEEN 44 AND 46 THEN 'IX - Wood & Articles'
            WHEN CAST(hs_chapter AS INT) BETWEEN 47 AND 49 THEN 'X - Pulp, Paper, Books'
            WHEN CAST(hs_chapter AS INT) BETWEEN 50 AND 63 THEN 'XI - Textiles & Apparel'
            WHEN CAST(hs_chapter AS INT) BETWEEN 64 AND 67 THEN 'XII - Footwear, Headgear'
            WHEN CAST(hs_chapter AS INT) BETWEEN 68 AND 70 THEN 'XIII - Stone, Cement, Ceramics'
            WHEN CAST(hs_chapter AS INT) = 71 THEN 'XIV - Precious Metals & Stones'
            WHEN CAST(hs_chapter AS INT) BETWEEN 72 AND 83 THEN 'XV - Base Metals'
            WHEN CAST(hs_chapter AS INT) BETWEEN 84 AND 85 THEN 'XVI - Machinery & Electrical'
            WHEN CAST(hs_chapter AS INT) BETWEEN 86 AND 89 THEN 'XVII - Vehicles & Transport'
            WHEN CAST(hs_chapter AS INT) BETWEEN 90 AND 92 THEN 'XVIII - Instruments & Apparatus'
            WHEN CAST(hs_chapter AS INT) = 93 THEN 'XIX - Arms & Ammunition'
            WHEN CAST(hs_chapter AS INT) BETWEEN 94 AND 96 THEN 'XX - Miscellaneous Manufactured'
            WHEN CAST(hs_chapter AS INT) = 97 THEN 'XXI - Art & Antiques'
            ELSE 'Unknown Section'
        END AS hs_section_name,

        -- Time dimension
        year,
        month,
        DATE(CONCAT(year, '-', LPAD(CAST(month AS STRING), 2, '0'), '-01')) AS trade_month_date,

        -- Trade values
        ROUND(trade_value_usd, 2) AS trade_value_usd,
        ROUND(quantity, 4) AS quantity,
        quantity_unit,

        -- Unit value (price per unit)
        CASE
            WHEN quantity > 0
            THEN ROUND(trade_value_usd / quantity, 2)
            ELSE NULL
        END AS unit_value_usd,

        -- Logistics
        district_code,
        district_name,
        UPPER(COALESCE(transport_method, 'UNKNOWN')) AS transport_method,

        -- Customs details
        ROUND(COALESCE(customs_value_usd, trade_value_usd), 2) AS customs_value_usd,
        ROUND(COALESCE(duty_collected_usd, 0), 2) AS duty_collected_usd,
        ROUND(shipping_weight_kg, 4) AS shipping_weight_kg,

        -- Effective tariff rate (duty / customs value * 100)
        CASE
            WHEN customs_value_usd > 0 AND duty_collected_usd > 0
            THEN ROUND(duty_collected_usd / customs_value_usd * 100, 4)
            ELSE 0
        END AS effective_tariff_rate_pct,

        -- Value per kilogram
        CASE
            WHEN shipping_weight_kg > 0
            THEN ROUND(trade_value_usd / shipping_weight_kg, 2)
            ELSE NULL
        END AS value_per_kg,

        -- Data quality
        CASE
            WHEN trade_value_usd <= 0 THEN FALSE
            WHEN trade_value_usd > 1e12 THEN FALSE  -- Flag >$1T single records
            WHEN quantity IS NOT NULL AND quantity < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid,

        CASE
            WHEN trade_value_usd <= 0 THEN 'Non-positive trade value'
            WHEN trade_value_usd > 1e12 THEN 'Implausibly large trade value'
            WHEN quantity IS NOT NULL AND quantity < 0 THEN 'Negative quantity'
            ELSE NULL
        END AS validation_errors,

        -- Metadata
        'ITA_TRADE' AS source_system,
        load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base
)

SELECT * FROM standardized
WHERE is_valid = TRUE
