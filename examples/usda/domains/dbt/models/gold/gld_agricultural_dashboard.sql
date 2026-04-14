{{ config(
    materialized='table',
    tags=['gold', 'dashboard', 'executive_summary', 'usda_analytics']
) }}

WITH crop_summary AS (
    SELECT
        CURRENT_DATE() as report_date,
        'CROP_YIELDS' as metric_category,

        -- National crop production metrics
        SUM(production_amount) as total_production_value,
        COUNT(DISTINCT state_code) as states_reporting,
        COUNT(DISTINCT commodity) as commodities_tracked,

        -- Current year performance
        AVG(CASE WHEN year = {{ var('current_crop_year') }} THEN yield_per_acre END) as current_avg_yield,
        AVG(CASE WHEN year = {{ var('current_crop_year') }} - 1 THEN yield_per_acre END) as prev_year_avg_yield,

        -- Trend indicators
        COUNT(CASE WHEN yield_trend_5yr = 'INCREASING' THEN 1 END) as counties_yield_increasing,
        COUNT(CASE WHEN yield_trend_5yr = 'DECREASING' THEN 1 END) as counties_yield_decreasing,
        COUNT(*) as total_county_records

    FROM {{ ref('gld_crop_yield_forecast') }}
    WHERE year IN ({{ var('current_crop_year') }}, {{ var('current_crop_year') }} - 1)
      AND commodity IN {{ var('major_commodities') }}
),

snap_summary AS (
    SELECT
        CURRENT_DATE() as report_date,
        'SNAP_ENROLLMENT' as metric_category,

        -- National enrollment metrics
        SUM(CASE WHEN is_latest_month THEN current_enrollment END) as current_total_enrollment,
        SUM(CASE WHEN is_latest_month THEN current_households END) as current_total_households,
        SUM(CASE WHEN is_latest_month THEN current_benefits_dollars END) as current_total_benefits,

        -- Trend indicators
        AVG(CASE WHEN is_latest_month AND enrollment_change_1yr IS NOT NULL
                 THEN enrollment_change_1yr END) as avg_enrollment_change_1yr,
        COUNT(CASE WHEN is_latest_month AND enrollment_trend = 'INCREASING' THEN 1 END) as states_enrollment_increasing,
        COUNT(CASE WHEN is_latest_month AND enrollment_trend = 'DECREASING' THEN 1 END) as states_enrollment_decreasing,
        COUNT(CASE WHEN is_latest_month THEN 1 END) as states_reporting

    FROM {{ ref('gld_snap_trends') }}
    WHERE is_current_data = TRUE
),

food_safety_summary AS (
    SELECT
        CURRENT_DATE() as report_date,
        'FOOD_SAFETY' as metric_category,

        -- Risk assessment metrics
        COUNT(*) as total_establishments,
        COUNT(CASE WHEN adjusted_risk_category = 'CRITICAL' THEN 1 END) as critical_risk_establishments,
        COUNT(CASE WHEN adjusted_risk_category = 'HIGH' THEN 1 END) as high_risk_establishments,
        COUNT(CASE WHEN recommended_action = 'IMMEDIATE_INSPECTION_REQUIRED' THEN 1 END) as immediate_action_required,

        -- Compliance metrics
        AVG(compliance_rate) as avg_compliance_rate,
        AVG(violation_rate_12_months) as avg_violation_rate,

        -- Inspection coverage
        COUNT(CASE WHEN days_since_last_inspection <= 365 THEN 1 END) as establishments_inspected_last_year,
        COUNT(CASE WHEN days_since_last_inspection > 365 THEN 1 END) as establishments_overdue_inspection

    FROM {{ ref('gld_food_safety_risk_score') }}
    WHERE is_risk_score_reliable = TRUE
),

-- Combine all metrics into dashboard summary
dashboard_metrics AS (
    SELECT
        report_date,

        -- Agricultural Production Metrics
        cs.total_production_value as agricultural_production_value,
        cs.states_reporting as agricultural_states_reporting,
        cs.commodities_tracked,

        -- Crop yield performance
        ROUND(cs.current_avg_yield, 1) as current_average_yield,
        CASE
            WHEN cs.prev_year_avg_yield > 0
            THEN ROUND((cs.current_avg_yield - cs.prev_year_avg_yield) / cs.prev_year_avg_yield * 100, 1)
            ELSE NULL
        END as yield_change_pct,

        ROUND(cs.counties_yield_increasing::DECIMAL / cs.total_county_records::DECIMAL * 100, 1) as pct_counties_yield_improving,

        -- SNAP Program Metrics
        ss.current_total_enrollment as snap_enrollment_total,
        ss.current_total_households as snap_households_total,
        ROUND(ss.current_total_benefits / 1000000, 1) as snap_benefits_millions,

        ROUND(ss.avg_enrollment_change_1yr, 1) as snap_enrollment_change_pct,
        ss.states_enrollment_increasing as states_snap_increasing,
        ss.states_enrollment_decreasing as states_snap_decreasing,

        -- Food Safety Metrics
        fs.total_establishments as food_establishments_total,
        fs.critical_risk_establishments,
        fs.high_risk_establishments,
        fs.immediate_action_required as food_safety_urgent_actions,

        ROUND(fs.avg_compliance_rate, 1) as food_safety_compliance_rate,
        ROUND(fs.avg_violation_rate, 1) as food_safety_violation_rate,

        -- Coverage and timeliness
        ROUND(fs.establishments_inspected_last_year::DECIMAL / fs.total_establishments::DECIMAL * 100, 1) as food_safety_inspection_coverage_pct,

        -- Economic indicators (placeholders for future integration)
        NULL as agricultural_employment,
        NULL as farm_income_index,
        NULL as food_price_index,
        NULL as rural_unemployment_rate,

        -- Summary status indicators
        CASE
            WHEN cs.counties_yield_increasing::DECIMAL / cs.total_county_records::DECIMAL >= 0.6 THEN 'POSITIVE'
            WHEN cs.counties_yield_increasing::DECIMAL / cs.total_county_records::DECIMAL >= 0.4 THEN 'STABLE'
            ELSE 'CONCERNING'
        END as agricultural_productivity_trend,

        CASE
            WHEN ss.avg_enrollment_change_1yr > 5 THEN 'INCREASING'
            WHEN ss.avg_enrollment_change_1yr < -5 THEN 'DECREASING'
            ELSE 'STABLE'
        END as snap_enrollment_trend,

        CASE
            WHEN fs.avg_compliance_rate >= 95 THEN 'EXCELLENT'
            WHEN fs.avg_compliance_rate >= 90 THEN 'GOOD'
            WHEN fs.avg_compliance_rate >= 80 THEN 'ADEQUATE'
            ELSE 'NEEDS_IMPROVEMENT'
        END as food_safety_status

    FROM crop_summary cs
    CROSS JOIN snap_summary ss
    CROSS JOIN food_safety_summary fs
),

-- Add comparative and contextual data
enriched_dashboard AS (
    SELECT
        *,

        -- Calculate key ratios and derived metrics
        CASE
            WHEN snap_enrollment_total > 0
            THEN ROUND(snap_benefits_millions * 1000000 / snap_enrollment_total, 0)
            ELSE 0
        END as avg_monthly_benefit_per_person,

        CASE
            WHEN food_establishments_total > 0
            THEN ROUND((critical_risk_establishments + high_risk_establishments)::DECIMAL / food_establishments_total::DECIMAL * 100, 1)
            ELSE 0
        END as pct_establishments_high_risk,

        -- Risk indicators
        CASE
            WHEN critical_risk_establishments > 100 THEN 'HIGH'
            WHEN critical_risk_establishments > 50 THEN 'MODERATE'
            ELSE 'LOW'
        END as food_safety_risk_level,

        -- Data quality indicators
        CASE
            WHEN agricultural_states_reporting >= 45 AND snap_enrollment_total > 0 AND food_establishments_total > 1000
            THEN TRUE
            ELSE FALSE
        END as is_complete_data,

        -- Alert flags
        CASE
            WHEN yield_change_pct < -10 OR food_safety_urgent_actions > 50 OR snap_enrollment_change_pct > 20
            THEN TRUE
            ELSE FALSE
        END as requires_executive_attention,

        -- Metadata
        'USDA_AGRICULTURAL_ANALYTICS' as data_source,
        CONCAT(
            'Agricultural: ', agricultural_states_reporting, ' states; ',
            'SNAP: ', states_snap_increasing + states_snap_decreasing, ' states; ',
            'Food Safety: ', food_establishments_total, ' establishments'
        ) as data_coverage_summary,

        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM dashboard_metrics
)

SELECT * FROM enriched_dashboard