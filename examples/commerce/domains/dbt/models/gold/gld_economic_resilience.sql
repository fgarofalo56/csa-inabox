{{ config(
    materialized='table',
    tags=['gold', 'economic_resilience', 'analytics']
) }}

{#
    Gold Layer: Regional Economic Resilience Index

    Computes a composite economic resilience score for each state-year
    combining three key dimensions:

    1. Employment Diversity Index (Shannon Entropy):
       Measures how evenly employment is distributed across industries.
       Higher diversity = more resilient to single-industry shocks.
       H = -SUM(p_i * ln(p_i)) where p_i is industry employment share.

    2. Herfindahl-Hirschman Index (HHI):
       Measures industry concentration in GDP.
       HHI = SUM(s_i^2) where s_i is industry GDP share.
       Lower HHI = less concentrated = more resilient.

    3. GDP Stability Score:
       Coefficient of variation of real GDP over the lookback period.
       Lower CV = more stable GDP = more resilient.

    Composite Score:
       resilience = w1 * norm(diversity) + w2 * norm(1 - HHI) + w3 * norm(stability)
       Weights configured in dbt_project.yml

    Output: One row per state per year with composite score and components.
#}

WITH -- Step 1: Aggregate annual GDP by state and industry
annual_gdp AS (
    SELECT
        state_fips,
        state_name,
        naics_sector,
        industry_name,
        year,
        -- Average quarterly GDP to get annual figure
        ROUND(AVG(gdp_real_dollars), 2) AS avg_quarterly_gdp,
        -- Annual sum (GDP is SAAR, so average gives annual rate)
        ROUND(SUM(gdp_real_dollars) / 4.0, 2) AS annual_gdp_real,
        AVG(gdp_growth_rate_yoy) AS avg_yoy_growth
    FROM {{ ref('slv_gdp_data') }}
    WHERE naics_sector != 'ALL'
      AND gdp_real_dollars > 0
      AND year >= YEAR(CURRENT_DATE()) - {{ var('historical_years_analysis') }}
    GROUP BY state_fips, state_name, naics_sector, industry_name, year
),

-- Step 2: State total GDP for share calculations
state_totals AS (
    SELECT
        state_fips,
        year,
        SUM(annual_gdp_real) AS total_gdp,
        COUNT(DISTINCT naics_sector) AS num_industries
    FROM annual_gdp
    GROUP BY state_fips, year
),

-- Step 3: Calculate industry GDP shares
industry_shares AS (
    SELECT
        a.state_fips,
        a.state_name,
        a.naics_sector,
        a.industry_name,
        a.year,
        a.annual_gdp_real,
        t.total_gdp,
        -- Industry GDP share (for HHI)
        CASE
            WHEN t.total_gdp > 0
            THEN a.annual_gdp_real / t.total_gdp
            ELSE 0
        END AS gdp_share,
        t.num_industries
    FROM annual_gdp a
    JOIN state_totals t ON a.state_fips = t.state_fips AND a.year = t.year
),

-- Step 4: Calculate HHI per state-year
hhi_calc AS (
    SELECT
        state_fips,
        state_name,
        year,
        total_gdp,
        num_industries,
        -- HHI = sum of squared shares (range 0 to 10000 when shares in %)
        ROUND(SUM(POWER(gdp_share * 100, 2)), 2) AS hhi_score,
        -- Identify dominant industry
        MAX_BY(industry_name, gdp_share) AS dominant_industry,
        MAX(gdp_share) AS dominant_industry_share
    FROM industry_shares
    GROUP BY state_fips, state_name, year, total_gdp, num_industries
),

-- Step 5: Employment diversity index (Shannon entropy)
-- Using GDP shares as proxy for employment distribution
employment_diversity AS (
    SELECT
        state_fips,
        year,
        -- Shannon entropy: H = -SUM(p * ln(p))
        -- Normalized to [0, 1] by dividing by ln(N)
        CASE
            WHEN COUNT(*) > 1
            THEN ROUND(
                -SUM(
                    CASE
                        WHEN gdp_share > 0
                        THEN gdp_share * LN(gdp_share)
                        ELSE 0
                    END
                ) / LN(COUNT(*)),
                4
            )
            ELSE 0
        END AS employment_diversity_index
    FROM industry_shares
    WHERE gdp_share > 0
    GROUP BY state_fips, year
),

-- Step 6: GDP stability (coefficient of variation over lookback window)
gdp_stability AS (
    SELECT
        state_fips,
        year,
        -- Coefficient of variation = stddev / mean * 100
        -- Lower CV = more stable = higher resilience
        CASE
            WHEN AVG(total_gdp) OVER w > 0
            THEN ROUND(
                STDDEV(total_gdp) OVER w / AVG(total_gdp) OVER w * 100, 2
            )
            ELSE NULL
        END AS gdp_cv,
        -- Convert to a stability score (inverse of CV, capped 0-100)
        CASE
            WHEN AVG(total_gdp) OVER w > 0
            THEN ROUND(
                GREATEST(0, 100 - (STDDEV(total_gdp) OVER w / AVG(total_gdp) OVER w * 100)), 2
            )
            ELSE 50  -- Default moderate stability
        END AS gdp_stability_score
    FROM state_totals
    WINDOW w AS (
        PARTITION BY state_fips
        ORDER BY year
        ROWS BETWEEN {{ var('historical_years_analysis') - 1 }} PRECEDING AND CURRENT ROW
    )
),

-- Step 7: Census demographics for context
demographics AS (
    SELECT
        state_fips,
        year,
        SUM(total_population) AS state_population,
        AVG(unemployment_rate) AS avg_unemployment_rate,
        AVG(median_household_income) AS avg_median_income,
        SUM(employed_population) AS total_employment
    FROM {{ ref('slv_census_demographics') }}
    GROUP BY state_fips, year
),

-- Step 8: Combine all components and compute composite score
combined AS (
    SELECT
        h.state_fips AS state_code,
        h.state_name,

        -- Geographic region (derived from FIPS)
        CASE
            WHEN h.state_fips IN ('09','23','25','33','34','36','42','44','50') THEN 'Northeast'
            WHEN h.state_fips IN ('17','18','19','20','26','27','29','31','38','39','46','55') THEN 'Midwest'
            WHEN h.state_fips IN ('01','05','10','11','12','13','21','22','24','28','37','40','45','47','48','51','54') THEN 'South'
            WHEN h.state_fips IN ('02','04','06','08','15','16','30','32','35','41','49','53','56') THEN 'West'
            ELSE 'Other'
        END AS region_name,

        h.year,

        -- Component scores
        ROUND(COALESCE(e.employment_diversity_index, 0), 4) AS employment_diversity_index,
        ROUND(h.hhi_score, 2) AS hhi_score,
        ROUND(COALESCE(s.gdp_stability_score, 50), 2) AS gdp_stability_score,
        ROUND(COALESCE(s.gdp_cv, 0), 2) AS gdp_coefficient_of_variation,

        -- Normalize components to 0-100 scale for composite scoring
        -- Diversity: already 0-1, multiply by 100
        ROUND(COALESCE(e.employment_diversity_index, 0) * 100, 2) AS diversity_score_normalized,
        -- HHI: invert (lower HHI = more resilient), normalize assuming max HHI ~3000
        ROUND(GREATEST(0, (1 - h.hhi_score / 3000.0) * 100), 2) AS hhi_score_normalized,
        -- Stability: already 0-100
        ROUND(COALESCE(s.gdp_stability_score, 50), 2) AS stability_score_normalized,

        -- Composite resilience score (weighted average of normalized components)
        ROUND(
            {{ var('employment_diversity_weight') }} * COALESCE(e.employment_diversity_index, 0) * 100
            + {{ var('hhi_weight') }} * GREATEST(0, (1 - h.hhi_score / 3000.0) * 100)
            + {{ var('gdp_stability_weight') }} * COALESCE(s.gdp_stability_score, 50),
            2
        ) AS resilience_score,

        -- Resilience category
        CASE
            WHEN (
                {{ var('employment_diversity_weight') }} * COALESCE(e.employment_diversity_index, 0) * 100
                + {{ var('hhi_weight') }} * GREATEST(0, (1 - h.hhi_score / 3000.0) * 100)
                + {{ var('gdp_stability_weight') }} * COALESCE(s.gdp_stability_score, 50)
            ) >= 80 THEN 'HIGHLY_RESILIENT'
            WHEN (
                {{ var('employment_diversity_weight') }} * COALESCE(e.employment_diversity_index, 0) * 100
                + {{ var('hhi_weight') }} * GREATEST(0, (1 - h.hhi_score / 3000.0) * 100)
                + {{ var('gdp_stability_weight') }} * COALESCE(s.gdp_stability_score, 50)
            ) >= 60 THEN 'RESILIENT'
            WHEN (
                {{ var('employment_diversity_weight') }} * COALESCE(e.employment_diversity_index, 0) * 100
                + {{ var('hhi_weight') }} * GREATEST(0, (1 - h.hhi_score / 3000.0) * 100)
                + {{ var('gdp_stability_weight') }} * COALESCE(s.gdp_stability_score, 50)
            ) >= 40 THEN 'MODERATE'
            WHEN (
                {{ var('employment_diversity_weight') }} * COALESCE(e.employment_diversity_index, 0) * 100
                + {{ var('hhi_weight') }} * GREATEST(0, (1 - h.hhi_score / 3000.0) * 100)
                + {{ var('gdp_stability_weight') }} * COALESCE(s.gdp_stability_score, 50)
            ) >= 20 THEN 'VULNERABLE'
            ELSE 'AT_RISK'
        END AS resilience_category,

        -- Industry context
        h.dominant_industry,
        ROUND(h.dominant_industry_share * 100, 2) AS dominant_industry_share_pct,
        h.num_industries,

        -- Economic context
        ROUND(h.total_gdp, 2) AS total_gdp_millions,
        COALESCE(d.state_population, 0) AS population,
        CASE
            WHEN d.state_population > 0
            THEN ROUND(h.total_gdp * 1000000.0 / d.state_population, 2)
            ELSE NULL
        END AS gdp_per_capita,
        COALESCE(d.total_employment, 0) AS total_employment,
        ROUND(d.avg_unemployment_rate, 2) AS unemployment_rate,
        ROUND(d.avg_median_income, 2) AS median_household_income,

        -- Ranking
        ROW_NUMBER() OVER (
            PARTITION BY h.year
            ORDER BY (
                {{ var('employment_diversity_weight') }} * COALESCE(e.employment_diversity_index, 0) * 100
                + {{ var('hhi_weight') }} * GREATEST(0, (1 - h.hhi_score / 3000.0) * 100)
                + {{ var('gdp_stability_weight') }} * COALESCE(s.gdp_stability_score, 50)
            ) DESC
        ) AS national_resilience_rank,

        -- Metadata
        CURRENT_DATE() AS report_date,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM hhi_calc h
    LEFT JOIN employment_diversity e ON h.state_fips = e.state_fips AND h.year = e.year
    LEFT JOIN gdp_stability s ON h.state_fips = s.state_fips AND h.year = s.year
    LEFT JOIN demographics d ON h.state_fips = d.state_fips AND h.year = d.year
)

SELECT * FROM combined
ORDER BY year DESC, resilience_score DESC
