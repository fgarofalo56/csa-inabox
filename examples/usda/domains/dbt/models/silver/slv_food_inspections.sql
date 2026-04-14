{{ config(
    materialized='incremental',
    unique_key='inspection_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'food_inspections', 'cleaned']
) }}

WITH base AS (
    SELECT * FROM {{ ref('brz_food_inspections') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            establishment_number,
            CAST(inspection_date as STRING),
            inspection_type,
            COALESCE(violation_type, 'NO_VIOLATION')
        )) as inspection_sk,

        -- Establishment identifiers
        TRIM(establishment_number) as establishment_number,
        COALESCE(UPPER(TRIM(establishment_name)), 'UNKNOWN') as establishment_name,
        COALESCE(UPPER(TRIM(company_name)), 'UNKNOWN') as company_name,

        -- Geographic standardization
        state_code,
        COALESCE(UPPER(TRIM(city)), 'UNKNOWN') as city,
        CASE
            WHEN zip_code ~ '^[0-9]{5}(-[0-9]{4})?$'
            THEN zip_code
            ELSE NULL
        END as zip_code,

        -- Time standardization
        inspection_date,
        EXTRACT(YEAR FROM inspection_date) as inspection_year,
        EXTRACT(MONTH FROM inspection_date) as inspection_month,
        EXTRACT(DOW FROM inspection_date) as inspection_day_of_week,

        -- Inspection categorization
        CASE
            WHEN UPPER(inspection_type) LIKE '%ROUTINE%' THEN 'ROUTINE'
            WHEN UPPER(inspection_type) LIKE '%FOLLOW%' OR UPPER(inspection_type) LIKE '%FOLLOWUP%' THEN 'FOLLOW_UP'
            WHEN UPPER(inspection_type) LIKE '%COMPLAINT%' THEN 'COMPLAINT'
            WHEN UPPER(inspection_type) LIKE '%VERIFICATION%' THEN 'VERIFICATION'
            WHEN UPPER(inspection_type) LIKE '%HACCP%' THEN 'HACCP'
            WHEN UPPER(inspection_type) LIKE '%SPECIAL%' THEN 'SPECIAL'
            ELSE UPPER(TRIM(inspection_type))
        END as inspection_type_category,

        inspection_type as inspection_type_original,

        CASE
            WHEN UPPER(inspection_disposition) LIKE '%COMPLIANT%' OR UPPER(inspection_disposition) LIKE '%SATISFACTORY%' THEN 'COMPLIANT'
            WHEN UPPER(inspection_disposition) LIKE '%NON%COMPLIANT%' OR UPPER(inspection_disposition) LIKE '%VIOLATION%' THEN 'NON_COMPLIANT'
            WHEN UPPER(inspection_disposition) LIKE '%PENDING%' THEN 'PENDING'
            WHEN UPPER(inspection_disposition) LIKE '%NO%ACTION%' THEN 'NO_ACTION_INDICATED'
            ELSE UPPER(TRIM(inspection_disposition))
        END as inspection_result,

        inspection_disposition as inspection_disposition_original,

        -- Violation standardization
        CASE
            WHEN violation_type IS NULL OR TRIM(violation_type) = '' THEN 'NO_VIOLATION'
            ELSE UPPER(TRIM(violation_type))
        END as violation_type,

        COALESCE(violation_description, 'No violations found') as violation_description,

        -- Severity scoring
        CASE
            WHEN UPPER(violation_severity) IN ('CRITICAL', 'HIGH', 'MAJOR') THEN 3
            WHEN UPPER(violation_severity) IN ('MODERATE', 'MEDIUM') THEN 2
            WHEN UPPER(violation_severity) IN ('MINOR', 'LOW') THEN 1
            WHEN violation_severity IS NULL OR violation_type = 'NO_VIOLATION' THEN 0
            ELSE 1  -- Default to minor if unclear
        END as violation_severity_score,

        violation_severity as violation_severity_original,

        citation_number,
        regulation_cited,
        corrective_action,
        corrective_action_date,

        -- Establishment characteristics
        CASE
            WHEN UPPER(establishment_type) LIKE '%SLAUGHTER%' THEN 'SLAUGHTER'
            WHEN UPPER(establishment_type) LIKE '%PROCESSING%' THEN 'PROCESSING'
            WHEN UPPER(establishment_type) LIKE '%WHOLESALE%' THEN 'WHOLESALE'
            WHEN UPPER(establishment_type) LIKE '%RETAIL%' THEN 'RETAIL'
            ELSE UPPER(TRIM(establishment_type))
        END as establishment_category,

        establishment_type as establishment_type_original,

        CASE
            WHEN UPPER(species) LIKE '%CATTLE%' OR UPPER(species) LIKE '%BEEF%' THEN 'CATTLE'
            WHEN UPPER(species) LIKE '%SWINE%' OR UPPER(species) LIKE '%PORK%' THEN 'SWINE'
            WHEN UPPER(species) LIKE '%POULTRY%' OR UPPER(species) LIKE '%CHICKEN%' OR UPPER(species) LIKE '%TURKEY%' THEN 'POULTRY'
            WHEN UPPER(species) LIKE '%SHEEP%' OR UPPER(species) LIKE '%LAMB%' THEN 'SHEEP'
            WHEN UPPER(species) LIKE '%GOAT%' THEN 'GOAT'
            WHEN UPPER(species) LIKE '%MULTI%' OR UPPER(species) LIKE '%MULTIPLE%' THEN 'MULTI_SPECIES'
            ELSE UPPER(TRIM(species))
        END as species_category,

        species as species_original,
        process_category,

        -- Size categorization
        CASE
            WHEN employee_count IS NULL THEN 'UNKNOWN'
            WHEN employee_count < 10 THEN 'VERY_SMALL'
            WHEN employee_count < 50 THEN 'SMALL'
            WHEN employee_count < 250 THEN 'MEDIUM'
            WHEN employee_count < 1000 THEN 'LARGE'
            ELSE 'VERY_LARGE'
        END as establishment_size_category,

        employee_count,

        -- Compliance indicators
        compliance_status,
        inspection_score,

        -- Data quality assessment
        CASE
            WHEN inspection_date > CURRENT_DATE() THEN FALSE
            WHEN inspection_date < DATE('1990-01-01') THEN FALSE
            WHEN violation_severity_score < 0 OR violation_severity_score > 3 THEN FALSE
            WHEN inspection_score IS NOT NULL AND (inspection_score < 0 OR inspection_score > 100) THEN FALSE
            ELSE TRUE
        END as is_valid,

        CASE
            WHEN inspection_date > CURRENT_DATE()
            THEN 'Future inspection date'
            WHEN inspection_date < DATE('1990-01-01')
            THEN 'Invalid historical date'
            WHEN violation_severity_score < 0 OR violation_severity_score > 3
            THEN 'Invalid severity score'
            WHEN inspection_score IS NOT NULL AND (inspection_score < 0 OR inspection_score > 100)
            THEN 'Invalid inspection score'
            ELSE NULL
        END as validation_errors,

        -- Metadata
        report_period,
        data_last_updated,
        inspector_id,
        inspection_duration_hours,
        source_system,
        ingestion_timestamp,
        record_hash,
        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM base
),

-- Add analytical enrichment
enriched AS (
    SELECT
        *,

        -- Calculate days since last inspection for this establishment
        LAG(inspection_date) OVER (
            PARTITION BY establishment_number
            ORDER BY inspection_date
        ) as previous_inspection_date,

        -- Count violations in the last 12 months
        COUNT(CASE WHEN violation_type != 'NO_VIOLATION' THEN 1 END) OVER (
            PARTITION BY establishment_number
            ORDER BY inspection_date
            RANGE BETWEEN INTERVAL '365' DAY PRECEDING AND CURRENT ROW
        ) as violations_last_12_months,

        -- Count total inspections in the last 12 months
        COUNT(*) OVER (
            PARTITION BY establishment_number
            ORDER BY inspection_date
            RANGE BETWEEN INTERVAL '365' DAY PRECEDING AND CURRENT ROW
        ) as inspections_last_12_months

    FROM standardized
),

final AS (
    SELECT
        *,

        -- Calculate days between inspections
        CASE
            WHEN previous_inspection_date IS NOT NULL
            THEN DATEDIFF('day', previous_inspection_date, inspection_date)
            ELSE NULL
        END as days_since_last_inspection,

        -- Calculate violation rate for establishment
        CASE
            WHEN inspections_last_12_months > 0
            THEN ROUND(violations_last_12_months::DECIMAL / inspections_last_12_months::DECIMAL * 100, 2)
            ELSE 0.0
        END as violation_rate_12_months

    FROM enriched
)

SELECT * FROM final
WHERE is_valid = TRUE