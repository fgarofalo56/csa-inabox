{{ config(
    materialized='incremental',
    unique_key=['trifid', 'reporting_year', 'chemical_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'tri', 'toxic_releases'],
    on_schema_change='fail'
) }}

{#
    Bronze layer: Raw TRI (Toxics Release Inventory) reports.

    Ingests annual toxic release reports from industrial facilities.
    Each record represents one facility's report for one chemical in one
    reporting year, with release quantities broken down by environmental
    medium (air, water, land, underground injection, off-site transfers).

    TRI data is reported annually with an 18-month lag (e.g., 2022 data
    is reported by July 2023, finalized by December 2023). Quantities
    are in pounds.

    Source: https://www.epa.gov/toxics-release-inventory-tri-program
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'TRI' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Facility identification
        COALESCE(CAST(trifid AS STRING), 'UNKNOWN') AS trifid,
        TRIM(facility_name) AS facility_name,

        -- Facility location
        TRIM(street_address) AS street_address,
        TRIM(city) AS city,
        UPPER(TRIM(state)) AS state,
        CAST(zip_code AS STRING) AS zip_code,
        LPAD(COALESCE(CAST(county_fips AS STRING), '00000'), 5, '0') AS county_fips,
        TRIM(county_name) AS county_name,
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,

        -- Industry classification
        CAST(primary_naics AS STRING) AS primary_naics,
        TRIM(industry_sector) AS industry_sector,

        -- Facility details
        CAST(number_of_employees AS INT) AS number_of_employees,
        TRIM(parent_company) AS parent_company,
        CAST(federal_facility AS BOOLEAN) AS is_federal_facility,

        -- Reporting period
        CAST(reporting_year AS INT) AS reporting_year,

        -- Chemical information
        COALESCE(CAST(chemical_id AS STRING),
            MD5(CONCAT_WS('|', trifid, chemical_name, CAST(reporting_year AS STRING)))
        ) AS chemical_id,
        UPPER(TRIM(chemical_name)) AS chemical_name,
        CAST(cas_number AS STRING) AS cas_number,
        UPPER(TRIM(chemical_classification)) AS chemical_classification,
        CAST(carcinogen AS BOOLEAN) AS is_carcinogen,
        CAST(pfas_chemical AS BOOLEAN) AS is_pfas,
        UPPER(TRIM(metal_category)) AS metal_category,

        -- Release quantities (pounds)
        CAST(COALESCE(fugitive_air AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS fugitive_air_lbs,
        CAST(COALESCE(stack_air AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS stack_air_lbs,
        CAST(COALESCE(water_discharge AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS water_discharge_lbs,
        CAST(COALESCE(underground_injection AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS underground_injection_lbs,
        CAST(COALESCE(land_disposal AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS land_disposal_lbs,
        CAST(COALESCE(offsite_transfer AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS offsite_transfer_lbs,
        CAST(COALESCE(total_releases AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS total_releases_lbs,

        -- Waste management
        CAST(COALESCE(onsite_recycled AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS onsite_recycled_lbs,
        CAST(COALESCE(onsite_energy_recovery AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS onsite_energy_recovery_lbs,
        CAST(COALESCE(onsite_treated AS DECIMAL(18,2), 0) AS DECIMAL(18,2)) AS onsite_treated_lbs,

        -- Source reduction
        CAST(source_reduction_activity AS STRING) AS source_reduction_activity,
        CAST(production_ratio AS DECIMAL(10,4)) AS production_ratio,

        -- Data quality flags
        CASE
            WHEN trifid IS NULL OR TRIM(trifid) = '' THEN FALSE
            WHEN reporting_year IS NULL THEN FALSE
            WHEN chemical_name IS NULL OR TRIM(chemical_name) = '' THEN FALSE
            WHEN state IS NULL OR TRIM(state) = '' THEN FALSE
            WHEN CAST(reporting_year AS INT) < 1987 THEN FALSE  -- TRI began in 1987
            WHEN CAST(reporting_year AS INT) > YEAR(CURRENT_DATE()) THEN FALSE
            WHEN total_releases IS NOT NULL AND CAST(total_releases AS DECIMAL(18,2)) < 0 THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN trifid IS NULL OR TRIM(trifid) = '' THEN 'Missing facility ID'
            WHEN reporting_year IS NULL THEN 'Missing reporting year'
            WHEN chemical_name IS NULL OR TRIM(chemical_name) = '' THEN 'Missing chemical name'
            WHEN state IS NULL OR TRIM(state) = '' THEN 'Missing state'
            WHEN CAST(reporting_year AS INT) < 1987 THEN 'Reporting year before TRI inception'
            WHEN CAST(reporting_year AS INT) > YEAR(CURRENT_DATE()) THEN 'Future reporting year'
            WHEN total_releases IS NOT NULL AND CAST(total_releases AS DECIMAL(18,2)) < 0 THEN 'Negative total releases'
            ELSE NULL
        END AS validation_errors,

        -- Processing metadata
        load_time,
        MD5(CONCAT_WS('|',
            COALESCE(CAST(trifid AS STRING), ''),
            COALESCE(CAST(reporting_year AS STRING), ''),
            COALESCE(CAST(chemical_name AS STRING), '')
        )) AS record_hash,

        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('epa', 'tri_releases') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND trifid IS NOT NULL
    AND reporting_year IS NOT NULL
    AND chemical_name IS NOT NULL
