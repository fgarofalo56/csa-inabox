{{ config(
    materialized='incremental',
    unique_key=['trade_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'ita', 'trade']
) }}

{#
    Bronze Layer: International Trade Flows

    Source: USA Trade Online (usatrade.census.gov), ITA trade data APIs
    Coverage: US imports and exports by partner country, commodity (HS code),
              district of entry/exit, and method of transportation

    Commodity classification: Harmonized System (HS) codes at 2, 4, and 6-digit levels
    Value: Customs value in US dollars for imports, FAS value for exports

    HS code structure:
    - 2-digit: Chapter (e.g., 84 = Machinery)
    - 4-digit: Heading (e.g., 8471 = Computers)
    - 6-digit: Subheading (e.g., 847130 = Laptops)

    Trade flow types:
    - EXPORT: Domestic and foreign exports
    - IMPORT: General and consumption imports
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'ITA_TRADE' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Trade transaction identifiers
        COALESCE(trade_id, MD5(CONCAT_WS('|',
            COALESCE(partner_country_code, ''),
            COALESCE(hs_code, ''),
            COALESCE(flow_type, ''),
            COALESCE(CAST(year AS STRING), ''),
            COALESCE(CAST(month AS STRING), ''),
            COALESCE(district_code, '')
        ))) AS trade_id,

        -- Flow classification
        UPPER(TRIM(flow_type)) AS flow_type,  -- 'EXPORT' or 'IMPORT'

        -- Partner country
        partner_country_code,      -- ISO 3166-1 alpha-3 code
        partner_country_name,
        partner_region,            -- World Bank region classification
        partner_income_group,      -- World Bank income group

        -- Commodity classification (Harmonized System)
        hs_code,                   -- Full HS code (up to 10 digits)
        SUBSTRING(hs_code, 1, 2) AS hs_chapter,
        SUBSTRING(hs_code, 1, 4) AS hs_heading,
        SUBSTRING(hs_code, 1, 6) AS hs_subheading,
        commodity_description,
        commodity_section,         -- HS section (I-XXI)

        -- Time dimension
        CAST(year AS INT) AS year,
        CAST(month AS INT) AS month,

        -- Trade values (US dollars)
        CAST(trade_value_usd AS DECIMAL(18, 2)) AS trade_value_usd,
        CAST(quantity AS DECIMAL(18, 4)) AS quantity,
        quantity_unit,

        -- Logistics
        district_code,
        district_name,
        transport_method,          -- 'AIR', 'VESSEL', 'TRUCK', 'RAIL', 'PIPELINE', 'OTHER'

        -- Customs information
        CAST(customs_value_usd AS DECIMAL(18, 2)) AS customs_value_usd,
        CAST(duty_collected_usd AS DECIMAL(18, 2)) AS duty_collected_usd,
        CAST(shipping_weight_kg AS DECIMAL(18, 4)) AS shipping_weight_kg,

        -- Quality flags
        CASE
            WHEN trade_value_usd IS NULL OR trade_value_usd < 0 THEN FALSE
            WHEN partner_country_code IS NULL OR LENGTH(partner_country_code) != 3 THEN FALSE
            WHEN hs_code IS NULL OR LENGTH(hs_code) < 2 THEN FALSE
            WHEN flow_type IS NULL OR UPPER(flow_type) NOT IN ('EXPORT', 'IMPORT') THEN FALSE
            WHEN year IS NULL OR year < 2000 OR year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN month IS NULL OR month < 1 OR month > 12 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN trade_value_usd IS NULL OR trade_value_usd < 0 THEN 'Missing or negative trade value'
            WHEN partner_country_code IS NULL OR LENGTH(partner_country_code) != 3 THEN 'Invalid country code'
            WHEN hs_code IS NULL OR LENGTH(hs_code) < 2 THEN 'Invalid HS code'
            WHEN flow_type IS NULL OR UPPER(flow_type) NOT IN ('EXPORT', 'IMPORT') THEN 'Invalid flow type'
            WHEN year IS NULL OR year < 2000 THEN 'Invalid year'
            WHEN month IS NULL OR month < 1 OR month > 12 THEN 'Invalid month'
            ELSE NULL
        END AS validation_errors,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Record hash for deduplication
        MD5(CONCAT_WS('|',
            COALESCE(partner_country_code, ''),
            COALESCE(hs_code, ''),
            COALESCE(flow_type, ''),
            COALESCE(CAST(year AS STRING), ''),
            COALESCE(CAST(month AS STRING), ''),
            COALESCE(district_code, '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('commerce', 'trade_transactions') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND year IS NOT NULL
    AND partner_country_code IS NOT NULL
    AND flow_type IS NOT NULL
