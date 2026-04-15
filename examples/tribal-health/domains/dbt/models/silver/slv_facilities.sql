{{ config(
    materialized='incremental',
    unique_key='facility_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'facilities', 'reference', 'hipaa']
) }}

/*
    Silver Layer — Standardized Facility Data

    Transforms raw facility reference data with:
    - Capacity utilization metrics based on bed counts and encounter volumes
    - Provider-to-population ratios for resource adequacy assessment
    - Services offered parsing into structured categories
    - Facility classification standardization

    Used as a dimension table for Gold-layer population health analytics.
*/

WITH base AS (
    SELECT * FROM {{ ref('brz_facilities') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Calculate encounter volumes per facility for utilization metrics
facility_encounters AS (
    SELECT
        facility_id,
        COUNT(*) AS total_encounters,
        COUNT(DISTINCT patient_id) AS unique_patients,
        COUNT(CASE WHEN encounter_type = 'INPATIENT' THEN 1 END) AS inpatient_encounters,
        COUNT(CASE WHEN encounter_type = 'OUTPATIENT' THEN 1 END) AS outpatient_encounters,
        COUNT(CASE WHEN encounter_type = 'ED' THEN 1 END) AS ed_encounters,
        COUNT(CASE WHEN encounter_type = 'TELEHEALTH' THEN 1 END) AS telehealth_encounters
    FROM {{ ref('brz_encounters') }}
    WHERE is_valid_record = TRUE
    GROUP BY facility_id
),

-- Aggregate population by service unit for provider ratios
service_unit_population AS (
    SELECT
        service_unit,
        COUNT(DISTINCT patient_id) AS enrolled_population
    FROM {{ ref('slv_patient_demographics') }}
    WHERE eligibility_status = 'ACTIVE'
    GROUP BY service_unit
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            f.facility_id,
            f.service_unit,
            f.facility_type
        )) AS facility_sk,

        -- Facility identifiers
        f.facility_id,
        f.facility_name,

        -- Facility classification
        f.facility_type,
        CASE
            WHEN f.facility_type = 'HOSPITAL' THEN 'IHS Hospital / Tribal Hospital'
            WHEN f.facility_type = 'HEALTH_CENTER' THEN 'IHS Health Center / Tribal Clinic'
            WHEN f.facility_type = 'SATELLITE' THEN 'Satellite Clinic / Health Station'
            ELSE 'Other'
        END AS facility_type_description,

        -- Organizational hierarchy
        f.service_unit,
        f.tribal_affiliation,
        f.state,

        -- Capacity
        f.bed_count,
        f.provider_count,

        -- Capacity utilization (based on encounter volume vs bed count)
        CASE
            WHEN f.bed_count IS NOT NULL AND f.bed_count > 0 AND fe.inpatient_encounters IS NOT NULL
            THEN ROUND(
                fe.inpatient_encounters::DECIMAL / (f.bed_count * 365) * 100, 2
            )
            ELSE NULL
        END AS bed_occupancy_rate_pct,

        -- Provider-to-population ratio (per 10,000 population)
        CASE
            WHEN f.provider_count IS NOT NULL AND f.provider_count > 0 AND sup.enrolled_population IS NOT NULL AND sup.enrolled_population > 0
            THEN ROUND(
                f.provider_count::DECIMAL / sup.enrolled_population * 10000, 2
            )
            ELSE NULL
        END AS provider_ratio_per_10000,

        -- Encounter volumes
        COALESCE(fe.total_encounters, 0) AS total_encounters,
        COALESCE(fe.unique_patients, 0) AS unique_patients,
        COALESCE(fe.inpatient_encounters, 0) AS inpatient_encounters,
        COALESCE(fe.outpatient_encounters, 0) AS outpatient_encounters,
        COALESCE(fe.ed_encounters, 0) AS ed_encounters,
        COALESCE(fe.telehealth_encounters, 0) AS telehealth_encounters,

        -- Telehealth adoption rate
        CASE
            WHEN fe.total_encounters IS NOT NULL AND fe.total_encounters > 0
            THEN ROUND(
                COALESCE(fe.telehealth_encounters, 0)::DECIMAL / fe.total_encounters * 100, 2
            )
            ELSE 0.0
        END AS telehealth_adoption_pct,

        -- Services offered (parsed from pipe-delimited string)
        f.services_offered,
        CASE WHEN f.services_offered LIKE '%PRIMARY_CARE%' THEN TRUE ELSE FALSE END AS has_primary_care,
        CASE WHEN f.services_offered LIKE '%DENTAL%' THEN TRUE ELSE FALSE END AS has_dental,
        CASE WHEN f.services_offered LIKE '%BEHAVIORAL_HEALTH%' OR f.services_offered LIKE '%MENTAL_HEALTH%' THEN TRUE ELSE FALSE END AS has_behavioral_health,
        CASE WHEN f.services_offered LIKE '%PHARMACY%' THEN TRUE ELSE FALSE END AS has_pharmacy,
        CASE WHEN f.services_offered LIKE '%OBSTETRICS%' OR f.services_offered LIKE '%OB%' THEN TRUE ELSE FALSE END AS has_obstetrics,
        CASE WHEN f.services_offered LIKE '%EMERGENCY%' OR f.services_offered LIKE '%ED%' THEN TRUE ELSE FALSE END AS has_emergency,
        CASE WHEN f.services_offered LIKE '%TELEHEALTH%' THEN TRUE ELSE FALSE END AS has_telehealth,

        -- Data quality
        TRUE AS is_valid,

        -- Metadata
        f.source_system,
        f.ingestion_timestamp,
        f.record_hash,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM base f
    LEFT JOIN facility_encounters fe ON f.facility_id = fe.facility_id
    LEFT JOIN service_unit_population sup ON f.service_unit = sup.service_unit
)

SELECT * FROM standardized
