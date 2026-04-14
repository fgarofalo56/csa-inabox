{{ config(
    materialized='incremental',
    unique_key=['pwsid', 'violation_id'],
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['bronze', 'sdwis', 'water_systems']
) }}

{#
    Bronze layer: Raw SDWIS (Safe Drinking Water Information System) data.

    Ingests water system compliance records including system inventory
    information, violations, enforcement actions, and water quality
    results. Each record represents a compliance event at a public
    water system.

    SDWIS data combines system-level attributes (population served,
    source type, system type) with violation-level detail (contaminant,
    violation type, compliance period).

    Source: https://www.epa.gov/enviro/sdwis-search
#}

WITH source_data AS (
    SELECT
        -- Source identification
        'SDWIS' AS source_system,
        CURRENT_TIMESTAMP() AS ingestion_timestamp,

        -- Water system identification
        COALESCE(CAST(pwsid AS STRING), 'UNKNOWN') AS pwsid,
        TRIM(pws_name) AS pws_name,

        -- System characteristics
        UPPER(TRIM(pws_type_code)) AS pws_type_code,  -- CWS, NTNCWS, TNCWS
        UPPER(TRIM(primary_source_code)) AS primary_source_code,  -- GW, SW, GU, SWP
        CAST(population_served_count AS INT) AS population_served_count,
        CAST(service_connections_count AS INT) AS service_connections_count,

        -- Geographic
        UPPER(TRIM(state_code)) AS state_code,
        UPPER(TRIM(county_name)) AS county_name,
        LPAD(COALESCE(CAST(county_fips AS STRING), '000'), 3, '0') AS county_fips,
        TRIM(city_name) AS city_name,
        CAST(zip_code AS STRING) AS zip_code,
        CAST(latitude AS DECIMAL(9,6)) AS latitude,
        CAST(longitude AS DECIMAL(9,6)) AS longitude,

        -- Violation details
        COALESCE(CAST(violation_id AS STRING),
            MD5(CONCAT_WS('|', pwsid, contaminant_code, CAST(compliance_begin_date AS STRING)))
        ) AS violation_id,
        CAST(contaminant_code AS STRING) AS contaminant_code,
        TRIM(contaminant_name) AS contaminant_name,
        UPPER(TRIM(violation_type_code)) AS violation_type_code,
        TRIM(violation_type_name) AS violation_type_name,

        -- Compliance period
        CAST(compliance_begin_date AS DATE) AS compliance_begin_date,
        CAST(compliance_end_date AS DATE) AS compliance_end_date,

        -- Violation status
        UPPER(TRIM(violation_status)) AS violation_status,
        UPPER(TRIM(severity_ind)) AS severity_ind,

        -- Enforcement
        CAST(enforcement_id AS STRING) AS enforcement_id,
        TRIM(enforcement_action_type) AS enforcement_action_type,
        CAST(enforcement_date AS DATE) AS enforcement_date,

        -- Health-based violation flag
        CASE
            WHEN UPPER(violation_type_code) IN ('MCL', 'MRDL', 'TT') THEN TRUE
            ELSE FALSE
        END AS is_health_based_violation,

        -- Data quality flags
        CASE
            WHEN pwsid IS NULL OR TRIM(pwsid) = '' THEN FALSE
            WHEN state_code IS NULL OR TRIM(state_code) = '' THEN FALSE
            WHEN compliance_begin_date IS NOT NULL
                 AND CAST(compliance_begin_date AS DATE) > CURRENT_DATE() THEN FALSE
            ELSE TRUE
        END AS is_valid_record,

        CASE
            WHEN pwsid IS NULL OR TRIM(pwsid) = '' THEN 'Missing water system ID'
            WHEN state_code IS NULL OR TRIM(state_code) = '' THEN 'Missing state code'
            WHEN compliance_begin_date IS NOT NULL
                 AND CAST(compliance_begin_date AS DATE) > CURRENT_DATE() THEN 'Future compliance date'
            ELSE NULL
        END AS validation_errors,

        -- Processing metadata
        load_time,
        MD5(CONCAT_WS('|',
            COALESCE(CAST(pwsid AS STRING), ''),
            COALESCE(CAST(violation_id AS STRING), ''),
            COALESCE(CAST(contaminant_code AS STRING), ''),
            COALESCE(CAST(compliance_begin_date AS STRING), '')
        )) AS record_hash,

        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM {{ source('epa', 'sdwis_water_systems') }}

    {% if is_incremental() %}
        WHERE load_time > (SELECT MAX(load_time) FROM {{ this }})
    {% endif %}
)

SELECT * FROM source_data
WHERE TRUE
    AND pwsid IS NOT NULL
    AND state_code IS NOT NULL
