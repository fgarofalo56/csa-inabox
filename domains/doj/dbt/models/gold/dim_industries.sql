-- materialized='table': Full rebuild required for referential integrity
-- when new industry sectors are discovered.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'doj', 'dimension', 'industries']
  )
}}

/*
  Gold: Industry dimension table.

  Provides standardized industry codes and descriptions for antitrust
  analysis across cases, HSR filings, and merger reviews.
*/

WITH distinct_industries AS (
    SELECT DISTINCT industry_sector
    FROM {{ ref('slv_antitrust_cases') }}
    WHERE is_valid = TRUE AND industry_sector IS NOT NULL

    UNION

    SELECT DISTINCT industry_sector
    FROM {{ ref('slv_civil_actions') }}
    WHERE is_valid = TRUE AND industry_sector IS NOT NULL

    UNION

    SELECT DISTINCT industry_sector
    FROM {{ ref('slv_merger_reviews') }}
    WHERE is_valid = TRUE AND industry_sector IS NOT NULL
),

industries_with_metadata AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['industry_sector']) }} AS industry_sk,
        industry_sector,
        CASE industry_sector
            WHEN 'HEALTHCARE' THEN 'HC'
            WHEN 'TECHNOLOGY' THEN 'TECH'
            WHEN 'TELECOMMUNICATIONS' THEN 'TELECOM'
            WHEN 'FINANCIAL_SERVICES' THEN 'FINSERV'
            WHEN 'ENERGY' THEN 'ENERGY'
            WHEN 'AGRICULTURE' THEN 'AGRI'
            WHEN 'MANUFACTURING' THEN 'MFG'
            WHEN 'TRANSPORTATION' THEN 'TRANS'
            WHEN 'REAL_ESTATE' THEN 'RE'
            WHEN 'RETAIL' THEN 'RETAIL'
            WHEN 'DEFENSE' THEN 'DEF'
            WHEN 'CONSTRUCTION' THEN 'CONST'
            WHEN 'PHARMACEUTICALS' THEN 'PHARMA'
            ELSE 'OTHER'
        END AS industry_code,
        CASE industry_sector
            WHEN 'HEALTHCARE' THEN 'Healthcare Services and Medical Devices'
            WHEN 'TECHNOLOGY' THEN 'Technology and Software Services'
            WHEN 'TELECOMMUNICATIONS' THEN 'Telecommunications and Media'
            WHEN 'FINANCIAL_SERVICES' THEN 'Financial Services and Banking'
            WHEN 'ENERGY' THEN 'Energy Production and Distribution'
            WHEN 'AGRICULTURE' THEN 'Agriculture and Food Processing'
            WHEN 'MANUFACTURING' THEN 'Manufacturing and Industrial Production'
            WHEN 'TRANSPORTATION' THEN 'Transportation and Logistics'
            WHEN 'REAL_ESTATE' THEN 'Real Estate and Property Management'
            WHEN 'RETAIL' THEN 'Retail and E-commerce'
            WHEN 'DEFENSE' THEN 'Defense and Aerospace'
            WHEN 'CONSTRUCTION' THEN 'Construction and Infrastructure'
            WHEN 'PHARMACEUTICALS' THEN 'Pharmaceutical and Biotechnology'
            ELSE 'Other Industries'
        END AS industry_description,
        CASE industry_sector
            WHEN 'HEALTHCARE' THEN TRUE
            WHEN 'TECHNOLOGY' THEN TRUE
            WHEN 'TELECOMMUNICATIONS' THEN TRUE
            WHEN 'FINANCIAL_SERVICES' THEN TRUE
            WHEN 'ENERGY' THEN TRUE
            WHEN 'PHARMACEUTICALS' THEN TRUE
            ELSE FALSE
        END AS is_highly_regulated,
        now() AS _dbt_refreshed_at
    FROM distinct_industries
)

SELECT * FROM industries_with_metadata