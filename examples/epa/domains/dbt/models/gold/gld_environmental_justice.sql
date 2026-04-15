{{ config(
    materialized='table',
    tags=['gold', 'environmental_justice', 'analytics']
) }}

{#
    Gold layer: Environmental justice — pollution burden index by census tract.

    Combines air quality data, toxic release proximity, and water system
    violations with demographic overlays to identify disproportionately
    burdened communities. Follows EPA EJScreen methodology for computing
    environmental indicators and demographic indices.

    Key metrics:
      - Average AQI and exceedance days per census tract
      - TRI facility proximity and chemical release tonnage
      - Water system violations weighted by population served
      - Composite EJ burden score (0–100)
      - Percentile ranking across all U.S. census tracts
      - Disadvantaged community flag

    In production, this model would join Census ACS demographic data.
    For this example, demographic features are derived from geographic
    proxies and should be replaced with actual Census API data.
#}

WITH tract_air_quality AS (
    -- Aggregate AQI to approximate census tract level (using county)
    SELECT
        state_code,
        county_code,
        observation_year,

        -- AQI metrics
        ROUND(AVG(daily_aqi), 1) AS avg_aqi,
        COUNT(CASE WHEN daily_aqi > 100 THEN 1 END) AS days_above_aqi_100,
        COUNT(CASE WHEN daily_aqi > 150 THEN 1 END) AS days_above_aqi_150,
        ROUND(MAX(daily_aqi), 0) AS max_aqi,

        -- PM2.5 specific
        ROUND(AVG(pm25_concentration), 2) AS avg_pm25_ug_m3,

        -- Ozone specific
        ROUND(AVG(ozone_concentration), 4) AS avg_ozone_ppm,

        -- Number of monitoring sites
        COUNT(DISTINCT site_id) AS aqi_monitor_count

    FROM {{ ref('gld_aqi_forecast') }}
    GROUP BY state_code, county_code, observation_year
),

tract_toxic_releases AS (
    -- Aggregate TRI data by county (proxy for census tract proximity)
    SELECT
        state,
        SUBSTRING(county_fips, 3, 3) AS county_code,
        reporting_year,

        -- Facility counts
        COUNT(DISTINCT trifid) AS tri_facilities_count,
        COUNT(DISTINCT CASE WHEN toxicity_tier = 'HIGH' THEN trifid END) AS high_toxicity_facilities,

        -- Release totals
        ROUND(SUM(total_releases_lbs), 2) AS total_chemical_releases_lbs,
        ROUND(SUM(total_air_releases_lbs), 2) AS total_air_releases_lbs,
        ROUND(SUM(water_discharge_lbs), 2) AS total_water_releases_lbs,

        -- Carcinogen releases
        ROUND(SUM(CASE WHEN is_carcinogen THEN total_releases_lbs ELSE 0 END), 2) AS carcinogen_releases_lbs,

        -- PFAS releases
        ROUND(SUM(CASE WHEN is_pfas THEN total_releases_lbs ELSE 0 END), 2) AS pfas_releases_lbs,

        -- Number of unique chemicals
        COUNT(DISTINCT chemical_name) AS unique_chemicals_reported

    FROM {{ ref('slv_toxic_releases') }}
    GROUP BY state, SUBSTRING(county_fips, 3, 3), reporting_year
),

tract_water_quality AS (
    -- Aggregate water system violations by county
    SELECT
        state_code,
        county_fips AS county_code,
        YEAR(compliance_begin_date) AS violation_year,

        -- Violation counts
        COUNT(DISTINCT violation_id) AS total_violations,
        COUNT(DISTINCT CASE WHEN violation_severity = 'HEALTH_BASED' THEN violation_id END) AS health_based_violations,
        COUNT(DISTINCT CASE WHEN is_critical_contaminant THEN violation_id END) AS critical_contaminant_violations,

        -- Active violations
        COUNT(DISTINCT CASE WHEN is_active_violation THEN violation_id END) AS active_violations,

        -- Population affected
        SUM(DISTINCT population_served) AS population_with_violations,

        -- Systems in violation
        COUNT(DISTINCT pwsid) AS systems_in_violation

    FROM {{ ref('slv_water_systems') }}
    WHERE violation_id IS NOT NULL
    GROUP BY state_code, county_fips, YEAR(compliance_begin_date)
),

-- Combine environmental indicators
combined_indicators AS (
    SELECT
        aq.state_code,
        aq.county_code,
        aq.observation_year AS assessment_year,

        -- Census tract approximation (state + county FIPS)
        CONCAT(aq.state_code, aq.county_code) AS census_tract,

        -- State name lookup (simplified)
        CASE
            WHEN aq.state_code = '06' THEN 'California'
            WHEN aq.state_code = '48' THEN 'Texas'
            WHEN aq.state_code = '36' THEN 'New York'
            WHEN aq.state_code = '17' THEN 'Illinois'
            WHEN aq.state_code = '42' THEN 'Pennsylvania'
            WHEN aq.state_code = '12' THEN 'Florida'
            WHEN aq.state_code = '39' THEN 'Ohio'
            WHEN aq.state_code = '22' THEN 'Louisiana'
            WHEN aq.state_code = '37' THEN 'North Carolina'
            ELSE CONCAT('State_', aq.state_code)
        END AS state_name,

        -- Air quality indicators
        COALESCE(aq.avg_aqi, 0) AS avg_aqi,
        COALESCE(aq.days_above_aqi_100, 0) AS days_above_aqi_100,
        COALESCE(aq.days_above_aqi_150, 0) AS days_above_aqi_150,
        COALESCE(aq.avg_pm25_ug_m3, 0) AS avg_pm25_ug_m3,
        COALESCE(aq.avg_ozone_ppm, 0) AS avg_ozone_ppm,

        -- Toxic release indicators
        COALESCE(tr.tri_facilities_count, 0) AS tri_facilities_within_3mi,
        COALESCE(tr.high_toxicity_facilities, 0) AS high_toxicity_facilities,
        COALESCE(tr.total_chemical_releases_lbs, 0) AS total_chemical_releases_lbs,
        COALESCE(tr.carcinogen_releases_lbs, 0) AS carcinogen_releases_lbs,
        COALESCE(tr.pfas_releases_lbs, 0) AS pfas_releases_lbs,
        COALESCE(tr.unique_chemicals_reported, 0) AS unique_chemicals,

        -- Water quality indicators
        COALESCE(wq.total_violations, 0) AS water_violations,
        COALESCE(wq.health_based_violations, 0) AS health_based_water_violations,
        COALESCE(wq.active_violations, 0) AS active_water_violations,
        COALESCE(wq.population_with_violations, 0) AS population_with_water_violations,

        -- Superfund placeholder (would join Superfund data in production)
        0 AS superfund_sites_within_5mi

    FROM tract_air_quality aq
    LEFT JOIN tract_toxic_releases tr
        ON aq.state_code = tr.state
        AND aq.county_code = tr.county_code
        AND aq.observation_year = tr.reporting_year
    LEFT JOIN tract_water_quality wq
        ON aq.state_code = wq.state_code
        AND aq.county_code = wq.county_code
        AND aq.observation_year = wq.violation_year
),

-- Calculate EJ burden score and percentiles
with_scores AS (
    SELECT
        *,

        -- Environmental Burden Score (0–100):
        -- Weighted combination of normalized environmental indicators
        ROUND(LEAST(100,
            -- Air quality component (0–30 points)
            LEAST(30,
                CASE
                    WHEN avg_aqi > 150 THEN 30
                    WHEN avg_aqi > 100 THEN 25
                    WHEN avg_aqi > 75 THEN 15
                    WHEN avg_aqi > 50 THEN 8
                    ELSE ROUND(avg_aqi / 50 * 5, 0)
                END
            )
            -- TRI proximity component (0–25 points)
            + LEAST(25,
                CASE
                    WHEN total_chemical_releases_lbs > 10000000 THEN 25  -- 10M+ lbs
                    WHEN total_chemical_releases_lbs > 1000000 THEN 20
                    WHEN total_chemical_releases_lbs > 100000 THEN 15
                    WHEN total_chemical_releases_lbs > 10000 THEN 10
                    WHEN tri_facilities_within_3mi > 0 THEN 5
                    ELSE 0
                END
            )
            -- Water quality component (0–20 points)
            + LEAST(20,
                CASE
                    WHEN health_based_water_violations > 5 THEN 20
                    WHEN health_based_water_violations > 2 THEN 15
                    WHEN health_based_water_violations > 0 THEN 10
                    WHEN water_violations > 0 THEN 5
                    ELSE 0
                END
            )
            -- Carcinogen/PFAS component (0–15 points)
            + LEAST(15,
                CASE
                    WHEN carcinogen_releases_lbs > 100000 THEN 15
                    WHEN carcinogen_releases_lbs > 10000 THEN 10
                    WHEN pfas_releases_lbs > 0 THEN 8
                    WHEN carcinogen_releases_lbs > 0 THEN 5
                    ELSE 0
                END
            )
            -- Superfund component (0–10 points)
            + LEAST(10, superfund_sites_within_5mi * 5)
        ), 0) AS ej_burden_score,

        -- Percentile ranking across all tracts
        PERCENT_RANK() OVER (
            PARTITION BY assessment_year
            ORDER BY (
                CASE WHEN avg_aqi > 150 THEN 30
                     WHEN avg_aqi > 100 THEN 25
                     WHEN avg_aqi > 50 THEN 10 ELSE 0 END
                + LEAST(25, total_chemical_releases_lbs / 100000)
                + health_based_water_violations * 5
            )
        ) * 100 AS ej_percentile

    FROM combined_indicators
),

-- Final output with classifications
final AS (
    SELECT
        census_tract,
        state_name AS state,
        CONCAT('County_', county_code) AS county,
        assessment_year,

        -- Demographic placeholders (in production, join Census ACS data)
        -- These would be real demographics from Census API
        NULL AS population,
        NULL AS pct_minority,
        NULL AS pct_low_income,
        NULL AS median_household_income,

        -- Environmental indicators
        avg_aqi,
        days_above_aqi_100,
        days_above_aqi_150,
        avg_pm25_ug_m3,
        avg_ozone_ppm,

        tri_facilities_within_3mi,
        total_chemical_releases_lbs,
        carcinogen_releases_lbs,
        pfas_releases_lbs,
        unique_chemicals,

        water_violations,
        health_based_water_violations,
        active_water_violations,

        superfund_sites_within_5mi,

        -- EJ scores
        CAST(ej_burden_score AS INT) AS ej_burden_score,
        ROUND(ej_percentile, 1) AS ej_percentile,

        -- EJ category
        CASE
            WHEN ej_percentile >= 95 THEN 'HIGHEST_BURDEN'
            WHEN ej_percentile >= {{ var('ej_percentile_threshold') }} THEN 'HIGH_BURDEN'
            WHEN ej_percentile >= 50 THEN 'MODERATE_BURDEN'
            WHEN ej_percentile >= 20 THEN 'LOW_BURDEN'
            ELSE 'MINIMAL_BURDEN'
        END AS ej_category,

        -- Disadvantaged community flag (EJScreen methodology)
        CASE
            WHEN ej_percentile >= {{ var('ej_percentile_threshold') }} THEN TRUE
            ELSE FALSE
        END AS is_disadvantaged_community,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM with_scores
)

SELECT * FROM final
ORDER BY ej_burden_score DESC
