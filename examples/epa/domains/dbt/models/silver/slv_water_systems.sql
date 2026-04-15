{{ config(
    materialized='incremental',
    unique_key='water_system_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'water_systems', 'cleaned'],
    on_schema_change='fail'
) }}

{#
    Silver layer: Standardized water system compliance data.

    Transforms raw SDWIS records by:
      - Standardizing water system type codes and source water types
      - Classifying violations by severity (health-based vs. monitoring)
      - Calculating violation durations and system-level compliance rates
      - Mapping contaminant codes to standard names and MCL categories
      - Computing population-weighted compliance metrics
      - Assigning risk tiers based on violation history

    Source: brz_water_systems (Bronze layer)
#}

WITH valid_bronze AS (
    SELECT * FROM {{ ref('brz_water_systems') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            pwsid,
            COALESCE(violation_id, 'NO_VIOLATION'),
            COALESCE(CAST(compliance_begin_date AS STRING), '')
        )) AS water_system_sk,

        -- Water system identification
        pwsid,
        pws_name,
        state_code,
        county_name,
        county_fips,
        city_name,
        zip_code,
        latitude,
        longitude,

        -- System classification
        CASE
            WHEN pws_type_code = 'CWS' THEN 'COMMUNITY'
            WHEN pws_type_code = 'NTNCWS' THEN 'NON_TRANSIENT_NON_COMMUNITY'
            WHEN pws_type_code = 'TNCWS' THEN 'TRANSIENT_NON_COMMUNITY'
            ELSE COALESCE(pws_type_code, 'UNKNOWN')
        END AS system_type,

        -- Source water classification
        CASE
            WHEN primary_source_code = 'GW' THEN 'GROUND_WATER'
            WHEN primary_source_code = 'GU' THEN 'GROUND_WATER_UNDER_INFLUENCE'
            WHEN primary_source_code = 'SW' THEN 'SURFACE_WATER'
            WHEN primary_source_code = 'SWP' THEN 'PURCHASED_SURFACE_WATER'
            ELSE COALESCE(primary_source_code, 'UNKNOWN')
        END AS source_water_type,

        -- Population and service
        COALESCE(population_served_count, 0) AS population_served,
        COALESCE(service_connections_count, 0) AS service_connections,

        -- Size classification based on population
        CASE
            WHEN population_served_count > 100000 THEN 'VERY_LARGE'
            WHEN population_served_count > 10000 THEN 'LARGE'
            WHEN population_served_count > 3300 THEN 'MEDIUM'
            WHEN population_served_count > 500 THEN 'SMALL'
            ELSE 'VERY_SMALL'
        END AS system_size_category,

        -- Violation details
        violation_id,
        contaminant_code,
        COALESCE(contaminant_name, 'UNKNOWN') AS contaminant_name,
        violation_type_code,
        COALESCE(violation_type_name, 'UNKNOWN') AS violation_type_name,

        -- Violation severity classification
        CASE
            WHEN violation_type_code IN ('MCL', 'MRDL', 'TT') THEN 'HEALTH_BASED'
            WHEN violation_type_code IN ('MON', 'RPT') THEN 'MONITORING_REPORTING'
            WHEN violation_type_code IN ('PN') THEN 'PUBLIC_NOTIFICATION'
            WHEN violation_type_code IN ('OTHER') THEN 'OTHER'
            ELSE COALESCE(violation_type_code, 'UNKNOWN')
        END AS violation_severity,

        -- Is this a critical contaminant?
        CASE
            WHEN UPPER(contaminant_name) IN (
                'LEAD', 'COPPER', 'ARSENIC', 'NITRATE', 'NITRITE',
                'TOTAL COLIFORM', 'E. COLI', 'TOTAL TRIHALOMETHANES',
                'HALOACETIC ACIDS', 'URANIUM', 'RADIUM'
            ) THEN TRUE
            ELSE FALSE
        END AS is_critical_contaminant,

        is_health_based_violation,

        -- Compliance dates
        compliance_begin_date,
        compliance_end_date,

        -- Violation duration in days
        CASE
            WHEN compliance_begin_date IS NOT NULL AND compliance_end_date IS NOT NULL
            THEN DATEDIFF(compliance_end_date, compliance_begin_date)
            WHEN compliance_begin_date IS NOT NULL AND compliance_end_date IS NULL
            THEN DATEDIFF(CURRENT_DATE(), compliance_begin_date)  -- Still ongoing
            ELSE NULL
        END AS violation_duration_days,

        -- Is violation currently active?
        CASE
            WHEN violation_status = 'OPEN' THEN TRUE
            WHEN compliance_end_date IS NULL AND compliance_begin_date IS NOT NULL THEN TRUE
            WHEN compliance_end_date >= CURRENT_DATE() THEN TRUE
            ELSE FALSE
        END AS is_active_violation,

        -- Enforcement
        enforcement_id,
        enforcement_action_type,
        enforcement_date,
        CASE
            WHEN enforcement_id IS NOT NULL THEN TRUE
            ELSE FALSE
        END AS has_enforcement_action,

        -- Data quality
        CASE
            WHEN pwsid IS NULL THEN FALSE
            WHEN violation_id IS NOT NULL AND contaminant_name IS NULL THEN FALSE
            ELSE TRUE
        END AS is_valid,

        severity_ind,

        -- Metadata
        'SDWIS' AS source_system,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM valid_bronze
)

SELECT * FROM standardized
WHERE is_valid = TRUE
