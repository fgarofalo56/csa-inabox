{{ config(
    materialized='incremental',
    unique_key='snap_enrollment_sk',
    merge_exclude_columns=['_dbt_loaded_at'],
    tags=['silver', 'snap_enrollment', 'cleaned']
) }}

WITH base AS (
    SELECT * FROM {{ ref('brz_snap_enrollment') }}
    WHERE is_valid_record = TRUE

    {% if is_incremental() %}
        AND _dbt_loaded_at > (SELECT MAX(_dbt_loaded_at) FROM {{ this }})
    {% endif %}
),

standardized AS (
    SELECT
        -- Surrogate key
        MD5(CONCAT_WS('|',
            state_code,
            month_year,
            program,
            COALESCE(county_fips, 'STATE_LEVEL')
        )) as snap_enrollment_sk,

        -- Geographic standardization
        state_code,
        COALESCE(UPPER(TRIM(state_name)),
            CASE state_code
                WHEN 'AL' THEN 'ALABAMA'
                WHEN 'AK' THEN 'ALASKA'
                WHEN 'AZ' THEN 'ARIZONA'
                WHEN 'AR' THEN 'ARKANSAS'
                WHEN 'CA' THEN 'CALIFORNIA'
                WHEN 'CO' THEN 'COLORADO'
                WHEN 'CT' THEN 'CONNECTICUT'
                WHEN 'DE' THEN 'DELAWARE'
                WHEN 'FL' THEN 'FLORIDA'
                WHEN 'GA' THEN 'GEORGIA'
                WHEN 'HI' THEN 'HAWAII'
                WHEN 'ID' THEN 'IDAHO'
                WHEN 'IL' THEN 'ILLINOIS'
                WHEN 'IN' THEN 'INDIANA'
                WHEN 'IA' THEN 'IOWA'
                WHEN 'KS' THEN 'KANSAS'
                WHEN 'KY' THEN 'KENTUCKY'
                WHEN 'LA' THEN 'LOUISIANA'
                WHEN 'ME' THEN 'MAINE'
                WHEN 'MD' THEN 'MARYLAND'
                WHEN 'MA' THEN 'MASSACHUSETTS'
                WHEN 'MI' THEN 'MICHIGAN'
                WHEN 'MN' THEN 'MINNESOTA'
                WHEN 'MS' THEN 'MISSISSIPPI'
                WHEN 'MO' THEN 'MISSOURI'
                WHEN 'MT' THEN 'MONTANA'
                WHEN 'NE' THEN 'NEBRASKA'
                WHEN 'NV' THEN 'NEVADA'
                WHEN 'NH' THEN 'NEW HAMPSHIRE'
                WHEN 'NJ' THEN 'NEW JERSEY'
                WHEN 'NM' THEN 'NEW MEXICO'
                WHEN 'NY' THEN 'NEW YORK'
                WHEN 'NC' THEN 'NORTH CAROLINA'
                WHEN 'ND' THEN 'NORTH DAKOTA'
                WHEN 'OH' THEN 'OHIO'
                WHEN 'OK' THEN 'OKLAHOMA'
                WHEN 'OR' THEN 'OREGON'
                WHEN 'PA' THEN 'PENNSYLVANIA'
                WHEN 'RI' THEN 'RHODE ISLAND'
                WHEN 'SC' THEN 'SOUTH CAROLINA'
                WHEN 'SD' THEN 'SOUTH DAKOTA'
                WHEN 'TN' THEN 'TENNESSEE'
                WHEN 'TX' THEN 'TEXAS'
                WHEN 'UT' THEN 'UTAH'
                WHEN 'VT' THEN 'VERMONT'
                WHEN 'VA' THEN 'VIRGINIA'
                WHEN 'WA' THEN 'WASHINGTON'
                WHEN 'WV' THEN 'WEST VIRGINIA'
                WHEN 'WI' THEN 'WISCONSIN'
                WHEN 'WY' THEN 'WYOMING'
                WHEN 'DC' THEN 'DISTRICT OF COLUMBIA'
                WHEN 'PR' THEN 'PUERTO RICO'
                WHEN 'VI' THEN 'VIRGIN ISLANDS'
                WHEN 'GU' THEN 'GUAM'
                ELSE 'UNKNOWN'
            END
        ) as state_name,

        county_fips,
        COALESCE(UPPER(TRIM(county_name)), 'STATE LEVEL') as county_name,

        -- Time standardization
        fiscal_year,
        month_number,
        COALESCE(UPPER(TRIM(month_name)),
            CASE month_number
                WHEN 1 THEN 'JANUARY'
                WHEN 2 THEN 'FEBRUARY'
                WHEN 3 THEN 'MARCH'
                WHEN 4 THEN 'APRIL'
                WHEN 5 THEN 'MAY'
                WHEN 6 THEN 'JUNE'
                WHEN 7 THEN 'JULY'
                WHEN 8 THEN 'AUGUST'
                WHEN 9 THEN 'SEPTEMBER'
                WHEN 10 THEN 'OCTOBER'
                WHEN 11 THEN 'NOVEMBER'
                WHEN 12 THEN 'DECEMBER'
                ELSE 'UNKNOWN'
            END
        ) as month_name,

        month_year,

        -- Create proper date from fiscal year and month
        MAKE_DATE(
            CASE
                WHEN month_number >= 10 THEN fiscal_year
                ELSE fiscal_year + 1
            END,
            month_number,
            1
        ) as enrollment_date,

        -- Program standardization
        UPPER(TRIM(program)) as program,
        COALESCE(UPPER(TRIM(program_type)), 'STANDARD') as program_type,

        -- Enrollment metrics
        COALESCE(persons, 0) as persons,
        COALESCE(households, 0) as households,
        COALESCE(benefits_dollars, 0.0) as benefits_dollars,
        COALESCE(issuance_dollars, 0.0) as issuance_dollars,

        -- Calculate per-capita metrics
        CASE
            WHEN persons > 0
            THEN ROUND(benefits_dollars / persons, 2)
            ELSE 0.0
        END as benefits_per_person,

        CASE
            WHEN households > 0
            THEN ROUND(benefits_dollars / households, 2)
            ELSE 0.0
        END as benefits_per_household,

        CASE
            WHEN households > 0 AND persons > 0
            THEN ROUND(persons::DECIMAL / households::DECIMAL, 2)
            ELSE 0.0
        END as persons_per_household,

        -- Participation rate
        participation_rate,

        -- Data quality indicators
        CASE
            WHEN persons = 0 AND households = 0 AND benefits_dollars = 0 THEN FALSE
            WHEN persons < 0 OR households < 0 OR benefits_dollars < 0 THEN FALSE
            WHEN persons > 0 AND households = 0 THEN FALSE  -- Logical constraint
            WHEN households > persons THEN FALSE  -- Logical constraint
            ELSE TRUE
        END as is_valid,

        CASE
            WHEN persons = 0 AND households = 0 AND benefits_dollars = 0
            THEN 'No enrollment data'
            WHEN persons < 0 OR households < 0 OR benefits_dollars < 0
            THEN 'Negative values'
            WHEN persons > 0 AND households = 0
            THEN 'Persons without households'
            WHEN households > persons
            THEN 'More households than persons'
            ELSE NULL
        END as validation_errors,

        -- Confidentiality and metadata
        confidentiality_flag,
        report_date,
        data_as_of_date,
        footnotes,

        -- Source metadata
        source_system,
        ingestion_timestamp,
        record_hash,
        CURRENT_TIMESTAMP() as _dbt_loaded_at

    FROM base
),

-- Add trend calculations
enriched AS (
    SELECT
        *,

        -- Year-over-year changes
        LAG(persons, 12) OVER (
            PARTITION BY state_code, program, county_fips
            ORDER BY enrollment_date
        ) as persons_prev_year,

        LAG(households, 12) OVER (
            PARTITION BY state_code, program, county_fips
            ORDER BY enrollment_date
        ) as households_prev_year,

        LAG(benefits_dollars, 12) OVER (
            PARTITION BY state_code, program, county_fips
            ORDER BY enrollment_date
        ) as benefits_dollars_prev_year,

        -- Moving averages (3-month)
        AVG(persons) OVER (
            PARTITION BY state_code, program, county_fips
            ORDER BY enrollment_date
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) as persons_3mo_avg,

        AVG(benefits_dollars) OVER (
            PARTITION BY state_code, program, county_fips
            ORDER BY enrollment_date
            ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ) as benefits_dollars_3mo_avg

    FROM standardized
),

final AS (
    SELECT
        *,

        -- Calculate year-over-year percentage changes
        CASE
            WHEN persons_prev_year > 0
            THEN ROUND((persons - persons_prev_year)::DECIMAL / persons_prev_year::DECIMAL * 100, 2)
            ELSE NULL
        END as persons_yoy_pct_change,

        CASE
            WHEN households_prev_year > 0
            THEN ROUND((households - households_prev_year)::DECIMAL / households_prev_year::DECIMAL * 100, 2)
            ELSE NULL
        END as households_yoy_pct_change,

        CASE
            WHEN benefits_dollars_prev_year > 0
            THEN ROUND((benefits_dollars - benefits_dollars_prev_year) / benefits_dollars_prev_year * 100, 2)
            ELSE NULL
        END as benefits_yoy_pct_change

    FROM enriched
)

SELECT * FROM final
WHERE is_valid = TRUE