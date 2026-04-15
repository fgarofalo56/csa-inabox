{{ config(
    materialized='incremental',
    unique_key=['state_fips', 'naics_sector', 'year', 'quarter'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'bea', 'gdp'],
    on_schema_change='fail'
) }}

{#
    Bronze Layer: BEA GDP and Economic Indicators

    Source: Bureau of Economic Analysis API (apps.bea.gov/api)
    Datasets:
    - Regional GDP (SQGDP): State-level quarterly GDP by industry
    - National GDP (NIPA): National income and product accounts
    - Personal Income (SQINC): State quarterly personal income

    BEA provides GDP in both current dollars and chained (real) dollars.
    This model ingests both and preserves the distinction.

    Industry classification follows NAICS 2-digit sectors.
    GDP values are in millions of dollars.
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'BEA_GDP' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Geographic identifiers
        CASE
            WHEN state_fips IS NULL THEN '00'  -- National level
            ELSE LPAD(state_fips, 2, '0')
        END AS state_fips,
        state_name,
        region_code,
        region_name,

        -- Time dimension
        CAST(year AS INT) AS year,
        CAST(quarter AS INT) AS quarter,
        CONCAT(CAST(year AS STRING), '-Q', CAST(quarter AS STRING)) AS year_quarter,

        -- Industry classification
        naics_sector,          -- 2-digit NAICS code
        industry_name,
        industry_description,

        -- GDP measurements (millions of dollars)
        CAST(gdp_current_dollars AS DECIMAL(18, 2)) AS gdp_current_dollars,
        CAST(gdp_chained_dollars AS DECIMAL(18, 2)) AS gdp_chained_dollars,

        -- GDP components
        CAST(personal_income AS DECIMAL(18, 2)) AS personal_income,
        CAST(compensation AS DECIMAL(18, 2)) AS compensation,
        CAST(taxes_on_production AS DECIMAL(18, 2)) AS taxes_on_production,
        CAST(subsidies AS DECIMAL(18, 2)) AS subsidies,
        CAST(gross_operating_surplus AS DECIMAL(18, 2)) AS gross_operating_surplus,

        -- Price indices
        CAST(price_index AS DECIMAL(10, 4)) AS price_index,
        CAST(quantity_index AS DECIMAL(10, 4)) AS quantity_index,

        -- BEA metadata
        table_name,
        line_code,
        unit_of_measure,
        scale_factor,
        CAST(is_seasonally_adjusted AS BOOLEAN) AS is_seasonally_adjusted,
        estimate_type,  -- 'ADVANCE', 'SECOND', 'THIRD', 'FINAL'

        -- Data quality flags
        CASE
            WHEN gdp_current_dollars IS NULL AND gdp_chained_dollars IS NULL THEN FALSE
            WHEN state_fips IS NULL AND region_code IS NULL THEN FALSE
            WHEN year IS NULL OR year < 1997 OR year > YEAR(CURRENT_DATE()) + 1 THEN FALSE
            WHEN quarter IS NULL OR quarter < 1 OR quarter > 4 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN gdp_current_dollars IS NULL AND gdp_chained_dollars IS NULL
                THEN 'Missing GDP values'
            WHEN state_fips IS NULL AND region_code IS NULL
                THEN 'Missing geographic identifier'
            WHEN year IS NULL OR year < 1997
                THEN 'Invalid year (BEA state GDP starts 1997)'
            WHEN quarter IS NULL OR quarter < 1 OR quarter > 4
                THEN 'Invalid quarter'
            ELSE NULL
        END AS validation_errors,

        -- Raw data preservation
        TO_JSON(STRUCT(*)) AS raw_json,

        -- Record deduplication hash
        MD5(CONCAT_WS('|',
            COALESCE(state_fips, '00'),
            COALESCE(naics_sector, 'ALL'),
            COALESCE(CAST(year AS STRING), ''),
            COALESCE(CAST(quarter AS STRING), '')
        )) AS record_hash,

        load_time,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('commerce', 'bea_gdp') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND year IS NOT NULL
    AND (state_fips IS NOT NULL OR region_code IS NOT NULL)
