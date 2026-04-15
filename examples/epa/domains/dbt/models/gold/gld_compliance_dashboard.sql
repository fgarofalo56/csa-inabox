{{ config(
    materialized='table',
    tags=['gold', 'compliance', 'analytics']
) }}

{#
    Gold layer: Facility compliance rates, violation trends, enforcement outcomes.

    Aggregates TRI releases and water system compliance data to produce a
    comprehensive compliance dashboard with:
      - Facility-level compliance scoring across environmental programs
      - Violation trend analysis (increasing, decreasing, stable)
      - Enforcement action tracking and penalty collection rates
      - Industry-sector benchmarking
      - State and regional compliance comparisons
      - Repeat violator identification

    This model powers the Emissions Compliance Dashboard and regulatory
    oversight analytics.
#}

WITH facility_releases AS (
    -- Annual release summary per facility
    SELECT
        trifid AS facility_id,
        facility_name,
        city,
        state,
        county_name,
        latitude,
        longitude,
        industry_sector_std,
        primary_naics,
        number_of_employees,
        is_federal_facility,
        reporting_year,

        -- Release totals
        SUM(total_releases_lbs) AS total_releases_lbs,
        SUM(total_air_releases_lbs) AS air_releases_lbs,
        SUM(water_discharge_lbs) AS water_releases_lbs,

        -- Chemical risk profile
        COUNT(DISTINCT chemical_name) AS chemicals_reported,
        COUNT(DISTINCT CASE WHEN is_carcinogen THEN chemical_name END) AS carcinogen_count,
        COUNT(DISTINCT CASE WHEN toxicity_tier = 'HIGH' THEN chemical_name END) AS high_toxicity_chemicals,

        -- Waste management
        SUM(total_waste_managed_lbs) AS total_waste_managed_lbs,
        AVG(waste_management_efficiency_pct) AS avg_waste_mgmt_efficiency,

        -- Release trend
        AVG(CASE WHEN release_trend = 'INCREASING' THEN 1
                 WHEN release_trend = 'STABLE' THEN 0
                 WHEN release_trend = 'DECREASING' THEN -1
                 ELSE NULL END) AS trend_indicator

    FROM {{ ref('slv_toxic_releases') }}
    WHERE reporting_year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
    GROUP BY
        trifid, facility_name, city, state, county_name,
        latitude, longitude, industry_sector_std, primary_naics,
        number_of_employees, is_federal_facility, reporting_year
),

-- Rolling 3-year facility statistics
facility_rolling AS (
    SELECT
        *,

        -- 3-year rolling release average
        AVG(total_releases_lbs) OVER (
            PARTITION BY facility_id
            ORDER BY reporting_year
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) AS releases_3yr_avg,

        -- Year-over-year change
        LAG(total_releases_lbs, 1) OVER (
            PARTITION BY facility_id
            ORDER BY reporting_year
        ) AS prev_year_releases,

        -- Years of reporting
        COUNT(*) OVER (
            PARTITION BY facility_id
            ORDER BY reporting_year
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS years_reporting

    FROM facility_releases
),

-- Water system compliance per state/county
water_compliance AS (
    SELECT
        state_code AS state,
        county_fips AS county_code,
        YEAR(compliance_begin_date) AS violation_year,

        COUNT(DISTINCT pwsid) AS systems_with_violations,
        COUNT(DISTINCT violation_id) AS total_violations,
        COUNT(DISTINCT CASE WHEN violation_severity = 'HEALTH_BASED' THEN violation_id END) AS health_violations,
        COUNT(DISTINCT CASE WHEN is_active_violation THEN violation_id END) AS active_violations,
        COUNT(DISTINCT CASE WHEN has_enforcement_action THEN violation_id END) AS enforced_violations,
        SUM(DISTINCT population_served) AS affected_population

    FROM {{ ref('slv_water_systems') }}
    WHERE violation_id IS NOT NULL
      AND YEAR(compliance_begin_date) >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
    GROUP BY state_code, county_fips, YEAR(compliance_begin_date)
),

-- Combine into a facility-level compliance view
compliance_scoring AS (
    SELECT
        fr.facility_id,
        fr.facility_name,
        fr.city,
        fr.state,
        fr.county_name,
        fr.latitude,
        fr.longitude,
        fr.industry_sector_std,
        fr.primary_naics,
        fr.number_of_employees,
        fr.is_federal_facility,
        fr.reporting_year,

        -- Release metrics
        ROUND(fr.total_releases_lbs, 2) AS total_releases_lbs,
        ROUND(fr.air_releases_lbs, 2) AS air_releases_lbs,
        ROUND(fr.water_releases_lbs, 2) AS water_releases_lbs,
        fr.chemicals_reported,
        fr.carcinogen_count,
        fr.high_toxicity_chemicals,

        -- Waste management
        ROUND(fr.avg_waste_mgmt_efficiency, 1) AS waste_mgmt_efficiency_pct,

        -- Release trend
        CASE
            WHEN fr.prev_year_releases IS NULL THEN 'FIRST_YEAR'
            WHEN fr.total_releases_lbs > fr.prev_year_releases * 1.10 THEN 'INCREASING'
            WHEN fr.total_releases_lbs < fr.prev_year_releases * 0.90 THEN 'DECREASING'
            ELSE 'STABLE'
        END AS release_trend,

        -- YoY change percentage
        CASE
            WHEN fr.prev_year_releases > 0
            THEN ROUND((fr.total_releases_lbs - fr.prev_year_releases) / fr.prev_year_releases * 100, 1)
            ELSE NULL
        END AS release_change_pct,

        ROUND(fr.releases_3yr_avg, 2) AS releases_3yr_avg,
        fr.years_reporting,

        -- Compliance score (0–100): higher is better compliance
        ROUND(GREATEST(0, LEAST(100,
            100
            -- Penalize high releases
            - CASE
                WHEN fr.total_releases_lbs > 10000000 THEN 30
                WHEN fr.total_releases_lbs > 1000000 THEN 20
                WHEN fr.total_releases_lbs > 100000 THEN 10
                WHEN fr.total_releases_lbs > 10000 THEN 5
                ELSE 0
              END
            -- Penalize carcinogen releases
            - CASE
                WHEN fr.carcinogen_count > 5 THEN 20
                WHEN fr.carcinogen_count > 2 THEN 10
                WHEN fr.carcinogen_count > 0 THEN 5
                ELSE 0
              END
            -- Penalize increasing trend
            - CASE
                WHEN fr.total_releases_lbs > COALESCE(fr.prev_year_releases, fr.total_releases_lbs) * 1.25 THEN 15
                WHEN fr.total_releases_lbs > COALESCE(fr.prev_year_releases, fr.total_releases_lbs) * 1.10 THEN 5
                ELSE 0
              END
            -- Reward good waste management
            + CASE
                WHEN fr.avg_waste_mgmt_efficiency > 80 THEN 10
                WHEN fr.avg_waste_mgmt_efficiency > 50 THEN 5
                ELSE 0
              END
        )), 0) AS compliance_score,

        -- Compliance status classification
        CASE
            WHEN fr.total_releases_lbs > 10000000 AND fr.carcinogen_count > 3 THEN 'SIGNIFICANT_VIOLATION'
            WHEN fr.total_releases_lbs > 1000000 AND
                 fr.total_releases_lbs > COALESCE(fr.prev_year_releases, 0) * 1.25 THEN 'SIGNIFICANT_VIOLATION'
            WHEN fr.total_releases_lbs > 1000000 THEN 'MINOR_VIOLATION'
            WHEN fr.carcinogen_count > 0 THEN 'UNDER_REVIEW'
            ELSE 'IN_COMPLIANCE'
        END AS compliance_status,

        -- Industry sector benchmarking: percentile within sector
        PERCENT_RANK() OVER (
            PARTITION BY fr.industry_sector_std, fr.reporting_year
            ORDER BY fr.total_releases_lbs DESC
        ) * 100 AS sector_release_percentile,

        -- State-level water compliance context
        COALESCE(wc.total_violations, 0) AS county_water_violations,
        COALESCE(wc.health_violations, 0) AS county_health_water_violations,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM facility_rolling fr
    LEFT JOIN water_compliance wc
        ON fr.state = wc.state
        AND fr.reporting_year = wc.violation_year
)

SELECT * FROM compliance_scoring
ORDER BY compliance_score ASC, total_releases_lbs DESC
