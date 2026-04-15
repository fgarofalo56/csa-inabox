{{ config(
    materialized='incremental',
    unique_key='census_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'census', 'demographics', 'cleaned'],
    on_schema_change='fail'
) }}

{#
    Silver Layer: Cleaned Census Demographics with Geographic Standardization

    Transforms raw Census ACS data into a structured, analytics-ready format.

    Key transformations:
    1. GEOID decomposition into state/county/tract with validated FIPS codes
    2. Variable pivot: converts row-per-variable into columnar demographic measures
    3. Geographic enrichment: adds MSA/CBSA, region, and division mappings
    4. Quality scoring: flags high-MOE estimates and statistical reliability
    5. Derived metrics: poverty rate, labor force participation, educational attainment

    Census variable groups pivoted:
    - B01001: Population totals
    - B19013: Median household income
    - B19301: Per capita income
    - B17001: Poverty status
    - B23025: Employment status
    - B15003: Educational attainment
    - B25001: Housing units
#}

WITH base AS (
    SELECT * FROM {{ ref('brz_census_demographics') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

-- Pivot census variables from rows into columns per geography-year
pivoted AS (
    SELECT
        geo_id,
        state_fips,
        county_fips,
        tract_code,
        state_name,
        county_name,
        year,
        dataset,

        -- Population (B01001_001E)
        MAX(CASE WHEN variable_code = 'B01001_001E' THEN estimate END) AS total_population,
        MAX(CASE WHEN variable_code = 'B01001_001E' THEN margin_of_error END) AS population_moe,

        -- Median household income (B19013_001E)
        MAX(CASE WHEN variable_code = 'B19013_001E' THEN estimate END) AS median_household_income,
        MAX(CASE WHEN variable_code = 'B19013_001E' THEN margin_of_error END) AS income_moe,

        -- Per capita income (B19301_001E)
        MAX(CASE WHEN variable_code = 'B19301_001E' THEN estimate END) AS per_capita_income,

        -- Median age (B01002_001E)
        MAX(CASE WHEN variable_code = 'B01002_001E' THEN estimate END) AS median_age,

        -- Population in poverty (B17001_002E) and total for poverty universe (B17001_001E)
        MAX(CASE WHEN variable_code = 'B17001_002E' THEN estimate END) AS population_in_poverty,
        MAX(CASE WHEN variable_code = 'B17001_001E' THEN estimate END) AS poverty_universe,

        -- Employment: civilian labor force (B23025_003E), employed (B23025_004E), unemployed (B23025_005E)
        MAX(CASE WHEN variable_code = 'B23025_002E' THEN estimate END) AS population_16_plus,
        MAX(CASE WHEN variable_code = 'B23025_003E' THEN estimate END) AS civilian_labor_force,
        MAX(CASE WHEN variable_code = 'B23025_004E' THEN estimate END) AS employed_population,
        MAX(CASE WHEN variable_code = 'B23025_005E' THEN estimate END) AS unemployed_population,

        -- Education: population 25+ (B15003_001E), bachelor's+ (sum B15003_022E through B15003_025E)
        MAX(CASE WHEN variable_code = 'B15003_001E' THEN estimate END) AS population_25_plus,
        MAX(CASE WHEN variable_code = 'B15003_017E' THEN estimate END) AS high_school_diploma,
        MAX(CASE WHEN variable_code = 'B15003_022E' THEN estimate END) AS bachelors_degree,
        MAX(CASE WHEN variable_code = 'B15003_023E' THEN estimate END) AS masters_degree,
        MAX(CASE WHEN variable_code = 'B15003_024E' THEN estimate END) AS professional_degree,
        MAX(CASE WHEN variable_code = 'B15003_025E' THEN estimate END) AS doctorate_degree,

        -- Housing units (B25001_001E)
        MAX(CASE WHEN variable_code = 'B25001_001E' THEN estimate END) AS total_housing_units,

        -- Track data completeness
        COUNT(DISTINCT variable_code) AS variables_available,
        MAX(load_time) AS latest_load_time

    FROM base
    GROUP BY geo_id, state_fips, county_fips, tract_code,
             state_name, county_name, year, dataset
),

-- Derive calculated metrics and add geographic enrichment
enriched AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|', geo_id, CAST(year AS STRING), dataset)) AS census_sk,

        -- Geography
        geo_id,
        state_fips,
        UPPER(TRIM(state_name)) AS state_name,
        county_fips,
        COALESCE(UPPER(TRIM(county_name)), 'UNKNOWN') AS county_name,
        tract_code,

        -- Region mapping (Census Bureau regions)
        CASE
            WHEN state_fips IN ('09','23','25','33','44','50') THEN 'NORTHEAST'
            WHEN state_fips IN ('34','36','42') THEN 'NORTHEAST'
            WHEN state_fips IN ('17','18','19','20','26','27','29','31','38','39','46','55') THEN 'MIDWEST'
            WHEN state_fips IN ('01','05','10','11','12','13','21','22','24','28','37','40','45','47','48','51','54') THEN 'SOUTH'
            WHEN state_fips IN ('02','04','06','08','15','16','30','32','35','41','49','53','56') THEN 'WEST'
            ELSE 'OTHER'
        END AS region,

        CASE
            WHEN state_fips IN ('09','23','25','33','44','50') THEN 'NEW_ENGLAND'
            WHEN state_fips IN ('34','36','42') THEN 'MIDDLE_ATLANTIC'
            WHEN state_fips IN ('17','18','26','39','55') THEN 'EAST_NORTH_CENTRAL'
            WHEN state_fips IN ('19','20','27','29','31','38','46') THEN 'WEST_NORTH_CENTRAL'
            WHEN state_fips IN ('10','11','12','13','24','37','45','51','54') THEN 'SOUTH_ATLANTIC'
            WHEN state_fips IN ('01','21','28','47') THEN 'EAST_SOUTH_CENTRAL'
            WHEN state_fips IN ('05','22','40','48') THEN 'WEST_SOUTH_CENTRAL'
            WHEN state_fips IN ('04','08','16','30','32','35','49','56') THEN 'MOUNTAIN'
            WHEN state_fips IN ('02','06','15','41','53') THEN 'PACIFIC'
            ELSE 'OTHER'
        END AS division,

        -- Time
        year,
        dataset,

        -- Demographics
        CAST(total_population AS BIGINT) AS total_population,
        CAST(median_age AS DECIMAL(4, 1)) AS median_age,
        CAST(total_housing_units AS BIGINT) AS total_housing_units,

        -- Income
        ROUND(median_household_income, 2) AS median_household_income,
        ROUND(per_capita_income, 2) AS per_capita_income,
        ROUND(income_moe, 2) AS income_moe,

        -- Poverty rate
        CASE
            WHEN poverty_universe > 0
            THEN ROUND(population_in_poverty / poverty_universe * 100, 2)
            ELSE NULL
        END AS poverty_rate,

        -- Employment metrics
        CAST(employed_population AS BIGINT) AS employed_population,
        CAST(unemployed_population AS BIGINT) AS unemployed_population,
        CAST(civilian_labor_force AS BIGINT) AS civilian_labor_force,

        CASE
            WHEN population_16_plus > 0
            THEN ROUND(civilian_labor_force / population_16_plus * 100, 2)
            ELSE NULL
        END AS labor_force_participation_rate,

        CASE
            WHEN civilian_labor_force > 0
            THEN ROUND(unemployed_population / civilian_labor_force * 100, 2)
            ELSE NULL
        END AS unemployment_rate,

        -- Education metrics
        CASE
            WHEN population_25_plus > 0
            THEN ROUND(
                (COALESCE(bachelors_degree, 0) + COALESCE(masters_degree, 0)
                 + COALESCE(professional_degree, 0) + COALESCE(doctorate_degree, 0))
                / population_25_plus * 100, 2)
            ELSE NULL
        END AS pct_bachelors_or_higher,

        CASE
            WHEN population_25_plus > 0
            THEN ROUND(
                (COALESCE(high_school_diploma, 0) + COALESCE(bachelors_degree, 0)
                 + COALESCE(masters_degree, 0) + COALESCE(professional_degree, 0)
                 + COALESCE(doctorate_degree, 0))
                / population_25_plus * 100, 2)
            ELSE NULL
        END AS pct_high_school_or_higher,

        -- Data quality scoring
        CASE
            WHEN total_population IS NOT NULL
                 AND median_household_income IS NOT NULL
                 AND employed_population IS NOT NULL
            THEN TRUE
            ELSE FALSE
        END AS is_valid,

        ROUND(variables_available / 15.0, 2) AS data_completeness_score,

        CASE
            WHEN income_moe IS NOT NULL AND median_household_income IS NOT NULL
                 AND median_household_income > 0
                 AND ABS(income_moe / 1.645) / median_household_income > 0.3
            THEN 'HIGH_CV: income estimate unreliable (CV > 30%)'
            WHEN total_population IS NULL THEN 'Missing population data'
            ELSE NULL
        END AS validation_errors,

        -- Metadata
        'CENSUS_ACS' AS source_system,
        latest_load_time AS load_time,
        CURRENT_TIMESTAMP() AS processed_timestamp,
        CURRENT_TIMESTAMP() AS _dbt_loaded_at

    FROM pivoted
)

SELECT * FROM enriched
WHERE is_valid = TRUE
