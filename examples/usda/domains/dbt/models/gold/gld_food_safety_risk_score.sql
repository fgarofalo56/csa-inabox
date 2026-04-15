{{ config(
    materialized='table',
    tags=['gold', 'food_safety', 'risk_assessment', 'analytics']
) }}

WITH base_inspections AS (
    SELECT
        establishment_number,
        establishment_name,
        company_name,
        state_code,
        city,
        zip_code,
        inspection_date,
        inspection_year,
        inspection_type_category,
        inspection_result,
        violation_type,
        violation_severity_score,
        establishment_category,
        species_category,
        establishment_size_category,
        employee_count,
        compliance_status,
        inspection_score,
        violations_last_12_months,
        inspections_last_12_months,
        violation_rate_12_months,
        days_since_last_inspection
    FROM {{ ref('slv_food_inspections') }}
    WHERE inspection_date >= DATE_SUB(CURRENT_DATE(), 365 * 3)  -- Last 3 years
),

-- Calculate establishment-level aggregations
establishment_metrics AS (
    SELECT
        establishment_number,
        MAX(establishment_name) as establishment_name,
        MAX(company_name) as company_name,
        MAX(state_code) as state_code,
        MAX(city) as city,
        MAX(zip_code) as zip_code,
        MAX(establishment_category) as establishment_category,
        MAX(species_category) as species_category,
        MAX(establishment_size_category) as establishment_size_category,
        MAX(employee_count) as employee_count,

        -- Time metrics
        MAX(inspection_date) as last_inspection_date,
        MIN(inspection_date) as first_inspection_date,
        COUNT(DISTINCT inspection_date) as total_inspections,

        -- Violation metrics
        COUNT(CASE WHEN violation_type != 'NO_VIOLATION' THEN 1 END) as total_violations,
        SUM(violation_severity_score) as total_severity_score,
        AVG(violation_severity_score) as avg_violation_severity,

        -- Compliance metrics
        COUNT(CASE WHEN inspection_result = 'COMPLIANT' THEN 1 END) as compliant_inspections,
        COUNT(CASE WHEN inspection_result = 'NON_COMPLIANT' THEN 1 END) as non_compliant_inspections,

        -- Recent performance (last 12 months)
        MAX(violations_last_12_months) as violations_last_12_months,
        MAX(inspections_last_12_months) as inspections_last_12_months,
        MAX(violation_rate_12_months) as violation_rate_12_months,

        -- Average inspection score
        AVG(CASE WHEN inspection_score IS NOT NULL THEN inspection_score END) as avg_inspection_score,

        -- Critical violations
        COUNT(CASE WHEN violation_severity_score = 3 THEN 1 END) as critical_violations,
        COUNT(CASE WHEN violation_severity_score = 2 THEN 1 END) as moderate_violations,
        COUNT(CASE WHEN violation_severity_score = 1 THEN 1 END) as minor_violations

    FROM base_inspections
    GROUP BY establishment_number
),

-- Calculate inspection frequency and patterns
frequency_analysis AS (
    SELECT
        *,

        -- Calculate inspection frequency
        CASE
            WHEN total_inspections > 1
            THEN ROUND(DATEDIFF('day', first_inspection_date, last_inspection_date)::DECIMAL / (total_inspections - 1), 1)
            ELSE NULL
        END as avg_days_between_inspections,

        -- Calculate compliance rate
        CASE
            WHEN total_inspections > 0
            THEN ROUND(compliant_inspections::DECIMAL / total_inspections::DECIMAL * 100, 2)
            ELSE NULL
        END as compliance_rate,

        -- Days since last inspection
        DATEDIFF('day', last_inspection_date, CURRENT_DATE()) as days_since_last_inspection

    FROM establishment_metrics
),

-- Risk scoring model
risk_scoring AS (
    SELECT
        *,

        -- Component scores (0-100 scale)

        -- 1. Violation History Score (40% weight)
        CASE
            WHEN violation_rate_12_months >= 75 THEN 100
            WHEN violation_rate_12_months >= 50 THEN 80
            WHEN violation_rate_12_months >= 25 THEN 60
            WHEN violation_rate_12_months >= 10 THEN 40
            WHEN violation_rate_12_months > 0 THEN 20
            ELSE 0
        END * {{ var('violation_severity_weight') }} as violation_history_score,

        -- 2. Inspection Frequency Score (30% weight) - less frequent = higher risk
        CASE
            WHEN days_since_last_inspection > 365 THEN 100
            WHEN days_since_last_inspection > 180 THEN 75
            WHEN days_since_last_inspection > 90 THEN 50
            WHEN days_since_last_inspection > 30 THEN 25
            ELSE 0
        END * {{ var('inspection_frequency_weight') }} as inspection_frequency_score,

        -- 3. Violation Recency Score (30% weight)
        CASE
            WHEN critical_violations > 0 THEN
                CASE
                    WHEN days_since_last_inspection <= 30 THEN 100
                    WHEN days_since_last_inspection <= 90 THEN 80
                    WHEN days_since_last_inspection <= 180 THEN 60
                    ELSE 40
                END
            WHEN moderate_violations > 0 THEN
                CASE
                    WHEN days_since_last_inspection <= 30 THEN 60
                    WHEN days_since_last_inspection <= 90 THEN 40
                    WHEN days_since_last_inspection <= 180 THEN 30
                    ELSE 20
                END
            WHEN minor_violations > 0 THEN
                CASE
                    WHEN days_since_last_inspection <= 30 THEN 30
                    WHEN days_since_last_inspection <= 90 THEN 20
                    ELSE 10
                END
            ELSE 0
        END * {{ var('violation_recency_weight') }} as violation_recency_score

    FROM frequency_analysis
),

-- Calculate final risk score and categorization
risk_categorization AS (
    SELECT
        *,

        -- Calculate total risk score
        ROUND(
            violation_history_score + inspection_frequency_score + violation_recency_score,
            1
        ) as risk_score,

        -- Risk categories
        CASE
            WHEN (violation_history_score + inspection_frequency_score + violation_recency_score) >= 80 THEN 'CRITICAL'
            WHEN (violation_history_score + inspection_frequency_score + violation_recency_score) >= 60 THEN 'HIGH'
            WHEN (violation_history_score + inspection_frequency_score + violation_recency_score) >= 40 THEN 'MODERATE'
            WHEN (violation_history_score + inspection_frequency_score + violation_recency_score) >= 20 THEN 'LOW'
            ELSE 'MINIMAL'
        END as risk_category

    FROM risk_scoring
),

-- Add industry and size context
industry_context AS (
    SELECT
        *,

        -- Industry risk adjustments
        CASE establishment_category
            WHEN 'SLAUGHTER' THEN 1.2  -- Higher baseline risk
            WHEN 'PROCESSING' THEN 1.1
            WHEN 'WHOLESALE' THEN 1.0
            WHEN 'RETAIL' THEN 0.9     -- Lower baseline risk
            ELSE 1.0
        END as industry_risk_multiplier,

        -- Size risk adjustments (larger operations = more complex)
        CASE establishment_size_category
            WHEN 'VERY_LARGE' THEN 1.2
            WHEN 'LARGE' THEN 1.1
            WHEN 'MEDIUM' THEN 1.0
            WHEN 'SMALL' THEN 0.9
            WHEN 'VERY_SMALL' THEN 0.8
            ELSE 1.0
        END as size_risk_multiplier

    FROM risk_categorization
),

-- Final risk assessment with adjustments
final_assessment AS (
    SELECT
        -- Establishment identifiers
        establishment_number,
        establishment_name,
        company_name,
        state_code,
        city,
        zip_code,
        establishment_category,
        species_category,
        establishment_size_category,
        employee_count,

        -- Risk assessment
        ROUND(risk_score * industry_risk_multiplier * size_risk_multiplier, 1) as adjusted_risk_score,

        CASE
            WHEN (risk_score * industry_risk_multiplier * size_risk_multiplier) >= 80 THEN 'CRITICAL'
            WHEN (risk_score * industry_risk_multiplier * size_risk_multiplier) >= 60 THEN 'HIGH'
            WHEN (risk_score * industry_risk_multiplier * size_risk_multiplier) >= 40 THEN 'MODERATE'
            WHEN (risk_score * industry_risk_multiplier * size_risk_multiplier) >= 20 THEN 'LOW'
            ELSE 'MINIMAL'
        END as adjusted_risk_category,

        risk_score as base_risk_score,
        risk_category as base_risk_category,

        -- Component scores for transparency
        ROUND(violation_history_score, 1) as violation_history_score,
        ROUND(inspection_frequency_score, 1) as inspection_frequency_score,
        ROUND(violation_recency_score, 1) as violation_recency_score,

        -- Historical performance
        total_inspections,
        total_violations,
        violations_last_12_months,
        inspections_last_12_months,
        violation_rate_12_months,
        compliance_rate,
        avg_violation_severity,
        avg_inspection_score,

        -- Violation breakdown
        critical_violations,
        moderate_violations,
        minor_violations,

        -- Timing indicators
        last_inspection_date,
        days_since_last_inspection,
        avg_days_between_inspections,

        -- Recommended actions
        CASE
            WHEN adjusted_risk_score >= 80 THEN 'IMMEDIATE_INSPECTION_REQUIRED'
            WHEN adjusted_risk_score >= 60 THEN 'PRIORITY_INSPECTION'
            WHEN days_since_last_inspection > 365 THEN 'OVERDUE_INSPECTION'
            WHEN adjusted_risk_score >= 40 THEN 'ROUTINE_INSPECTION'
            ELSE 'STANDARD_MONITORING'
        END as recommended_action,

        CASE
            WHEN adjusted_risk_score >= 80 THEN 7   -- Days
            WHEN adjusted_risk_score >= 60 THEN 30
            WHEN days_since_last_inspection > 365 THEN 14
            WHEN adjusted_risk_score >= 40 THEN 90
            ELSE 180
        END as recommended_inspection_frequency_days,

        -- Quality indicators
        CASE
            WHEN total_inspections >= 3
                 AND last_inspection_date >= DATE_SUB(CURRENT_DATE(), 365)
            THEN TRUE
            ELSE FALSE
        END as is_risk_score_reliable,

        -- Metadata
        CURRENT_DATE() as assessment_date,
        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM industry_context
)

SELECT * FROM final_assessment
WHERE total_inspections > 0  -- Only include establishments with inspection history
ORDER BY adjusted_risk_score DESC, state_code, establishment_name