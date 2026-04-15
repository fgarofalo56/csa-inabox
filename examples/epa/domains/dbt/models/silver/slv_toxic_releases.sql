{{ config(
    materialized='incremental',
    unique_key='tri_report_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'toxic_releases', 'cleaned']
) }}

{#
    Silver layer: Normalized TRI with chemical classifications.

    Transforms raw TRI (Toxics Release Inventory) reports by:
      - Computing total on-site and off-site release breakdowns
      - Classifying chemicals by toxicity, carcinogenicity, and persistence
      - Mapping NAICS codes to human-readable industry sectors
      - Calculating air vs. water vs. land release percentages
      - Computing year-over-year release trend indicators
      - Deriving waste management efficiency ratios

    Source: brz_toxic_releases (Bronze layer)
#}

WITH valid_bronze AS (
    SELECT * FROM {{ ref('brz_toxic_releases') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            trifid,
            CAST(reporting_year AS STRING),
            chemical_name
        )) AS tri_report_sk,

        -- Facility identification
        trifid,
        facility_name,
        street_address,
        city,
        state,
        zip_code,
        county_fips,
        county_name,
        latitude,
        longitude,

        -- Industry classification
        primary_naics,

        -- Map NAICS to readable sector names
        CASE
            WHEN primary_naics LIKE '211%' THEN 'OIL_GAS_EXTRACTION'
            WHEN primary_naics LIKE '212%' THEN 'MINING'
            WHEN primary_naics LIKE '22%'  THEN 'UTILITIES'
            WHEN primary_naics LIKE '311%' OR primary_naics LIKE '312%' THEN 'FOOD_BEVERAGE'
            WHEN primary_naics LIKE '313%' OR primary_naics LIKE '314%' THEN 'TEXTILES'
            WHEN primary_naics LIKE '321%' THEN 'WOOD_PRODUCTS'
            WHEN primary_naics LIKE '322%' THEN 'PAPER_MANUFACTURING'
            WHEN primary_naics LIKE '324%' THEN 'PETROLEUM_REFINING'
            WHEN primary_naics LIKE '325%' THEN 'CHEMICAL_MANUFACTURING'
            WHEN primary_naics LIKE '326%' THEN 'PLASTICS_RUBBER'
            WHEN primary_naics LIKE '327%' THEN 'NONMETALLIC_MINERALS'
            WHEN primary_naics LIKE '331%' THEN 'PRIMARY_METALS'
            WHEN primary_naics LIKE '332%' THEN 'FABRICATED_METALS'
            WHEN primary_naics LIKE '333%' THEN 'MACHINERY'
            WHEN primary_naics LIKE '334%' THEN 'ELECTRONICS'
            WHEN primary_naics LIKE '335%' THEN 'ELECTRICAL_EQUIPMENT'
            WHEN primary_naics LIKE '336%' THEN 'TRANSPORTATION_EQUIPMENT'
            WHEN primary_naics LIKE '337%' THEN 'FURNITURE'
            WHEN primary_naics LIKE '339%' THEN 'MISCELLANEOUS_MANUFACTURING'
            WHEN primary_naics LIKE '49%'  THEN 'WAREHOUSING'
            WHEN primary_naics LIKE '56%'  THEN 'WASTE_MANAGEMENT'
            ELSE COALESCE(industry_sector, 'OTHER')
        END AS industry_sector_std,

        number_of_employees,
        parent_company,
        is_federal_facility,

        -- Temporal
        reporting_year,

        -- Chemical identification
        chemical_id,
        chemical_name,
        cas_number,

        -- Chemical classification
        COALESCE(chemical_classification, 'UNCLASSIFIED') AS chemical_classification,
        COALESCE(is_carcinogen, FALSE) AS is_carcinogen,
        COALESCE(is_pfas, FALSE) AS is_pfas,
        metal_category,

        -- Toxicity tier assignment
        CASE
            WHEN is_carcinogen = TRUE THEN 'HIGH'
            WHEN is_pfas = TRUE THEN 'HIGH'
            WHEN chemical_name IN {{ var('tri_high_concern_chemicals') }} THEN 'HIGH'
            WHEN metal_category IS NOT NULL THEN 'MEDIUM'
            ELSE 'STANDARD'
        END AS toxicity_tier,

        -- Release quantities by medium
        fugitive_air_lbs,
        stack_air_lbs,
        fugitive_air_lbs + stack_air_lbs AS total_air_releases_lbs,
        water_discharge_lbs,
        underground_injection_lbs,
        land_disposal_lbs,
        offsite_transfer_lbs,
        total_releases_lbs,

        -- On-site vs off-site breakdown
        fugitive_air_lbs + stack_air_lbs + water_discharge_lbs
            + underground_injection_lbs + land_disposal_lbs AS onsite_releases_lbs,
        offsite_transfer_lbs AS offsite_releases_lbs,

        -- Release medium percentages
        CASE
            WHEN total_releases_lbs > 0
            THEN ROUND((fugitive_air_lbs + stack_air_lbs) / total_releases_lbs * 100, 2)
            ELSE 0
        END AS pct_air_releases,

        CASE
            WHEN total_releases_lbs > 0
            THEN ROUND(water_discharge_lbs / total_releases_lbs * 100, 2)
            ELSE 0
        END AS pct_water_releases,

        CASE
            WHEN total_releases_lbs > 0
            THEN ROUND((land_disposal_lbs + underground_injection_lbs) / total_releases_lbs * 100, 2)
            ELSE 0
        END AS pct_land_releases,

        -- Waste management quantities
        onsite_recycled_lbs,
        onsite_energy_recovery_lbs,
        onsite_treated_lbs,
        onsite_recycled_lbs + onsite_energy_recovery_lbs + onsite_treated_lbs AS total_waste_managed_lbs,

        -- Waste management efficiency
        CASE
            WHEN total_releases_lbs + onsite_recycled_lbs + onsite_energy_recovery_lbs + onsite_treated_lbs > 0
            THEN ROUND(
                (onsite_recycled_lbs + onsite_energy_recovery_lbs + onsite_treated_lbs)
                / (total_releases_lbs + onsite_recycled_lbs + onsite_energy_recovery_lbs + onsite_treated_lbs) * 100
            , 2)
            ELSE NULL
        END AS waste_management_efficiency_pct,

        -- Production ratio (source reduction indicator)
        production_ratio,
        source_reduction_activity,

        -- Year-over-year release change (computed via window function)
        LAG(total_releases_lbs, 1) OVER (
            PARTITION BY trifid, chemical_name
            ORDER BY reporting_year
        ) AS prev_year_releases_lbs,

        -- Data quality
        CASE
            WHEN total_releases_lbs < 0 THEN FALSE
            WHEN fugitive_air_lbs < 0 OR stack_air_lbs < 0 THEN FALSE
            WHEN water_discharge_lbs < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid,

        -- Metadata
        'TRI' AS source_system,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM valid_bronze
),

-- Add YoY change calculation
with_trends AS (
    SELECT
        *,

        CASE
            WHEN prev_year_releases_lbs IS NOT NULL AND prev_year_releases_lbs > 0
            THEN ROUND((total_releases_lbs - prev_year_releases_lbs) / prev_year_releases_lbs * 100, 2)
            ELSE NULL
        END AS release_change_pct_yoy,

        CASE
            WHEN prev_year_releases_lbs IS NULL THEN 'FIRST_REPORT'
            WHEN total_releases_lbs > prev_year_releases_lbs * 1.10 THEN 'INCREASING'
            WHEN total_releases_lbs < prev_year_releases_lbs * 0.90 THEN 'DECREASING'
            ELSE 'STABLE'
        END AS release_trend

    FROM standardized
)

SELECT * FROM with_trends
WHERE is_valid = TRUE
