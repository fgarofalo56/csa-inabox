-- materialized='table': Full rebuild required for comprehensive fact table
-- joining multiple sources with complex business logic.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'doj', 'fact', 'enforcement']
  )
}}

/*
  Gold: Unified enforcement actions fact table.

  Combines cases, criminal enforcement, and civil actions into a comprehensive
  view of DOJ antitrust enforcement activity with key metrics and dimensions.
*/

WITH cases AS (
    SELECT
        case_sk,
        case_id,
        case_name,
        case_type,
        filing_date,
        court_district,
        industry_sector,
        violation_type,
        status,
        defendant_name,
        defendant_type,
        resolution_date
    FROM {{ ref('slv_antitrust_cases') }}
    WHERE is_valid = TRUE
),

criminal_enforcement AS (
    SELECT
        case_id,
        SUM(fine_amount) AS total_criminal_fines,
        SUM(jail_days_imposed) AS total_jail_days,
        SUM(restitution_amount) AS total_restitution,
        COUNT(*) AS criminal_defendants
    FROM {{ ref('slv_criminal_enforcement') }}
    WHERE is_valid = TRUE
    GROUP BY case_id
),

civil_actions AS (
    SELECT
        case_id,
        COUNT(*) AS civil_actions_count,
        COUNT(CASE WHEN outcome = 'SETTLED' THEN 1 END) AS settled_actions,
        COUNT(CASE WHEN outcome = 'LITIGATED' THEN 1 END) AS litigated_actions,
        COUNT(CASE WHEN relief_sought = 'DIVESTITURE' THEN 1 END) AS divestiture_actions,
        COUNT(CASE WHEN relief_sought = 'INJUNCTION' THEN 1 END) AS injunction_actions
    FROM {{ ref('slv_civil_actions') }}
    WHERE is_valid = TRUE
    GROUP BY case_id
),

industry_dim AS (
    SELECT industry_sk, industry_sector, industry_code, is_highly_regulated
    FROM {{ ref('dim_industries') }}
),

violation_dim AS (
    SELECT violation_sk, violation_type, statutory_basis, is_criminal_violation, enforcement_priority
    FROM {{ ref('dim_violation_types') }}
),

final AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['c.case_id']) }} AS enforcement_fact_sk,
        c.case_sk,
        i.industry_sk,
        v.violation_sk,
        c.case_id,
        c.case_name,
        c.case_type,
        c.filing_date,
        c.court_district,
        c.defendant_name,
        c.defendant_type,
        c.status,
        c.resolution_date,

        -- Date calculations
        YEAR(c.filing_date) AS filing_year,
        CASE
            WHEN MONTH(c.filing_date) >= {{ var('fiscal_year_start_month') }}
            THEN YEAR(c.filing_date) + 1
            ELSE YEAR(c.filing_date)
        END AS fiscal_year,
        DATEDIFF('day', c.filing_date, COALESCE(c.resolution_date, current_date())) AS days_to_resolution,

        -- Criminal enforcement metrics
        COALESCE(ce.total_criminal_fines, 0) AS total_criminal_fines,
        COALESCE(ce.total_jail_days, 0) AS total_jail_days,
        COALESCE(ce.total_restitution, 0) AS total_restitution,
        COALESCE(ce.criminal_defendants, 0) AS criminal_defendants,

        -- Civil action metrics
        COALESCE(ca.civil_actions_count, 0) AS civil_actions_count,
        COALESCE(ca.settled_actions, 0) AS settled_actions,
        COALESCE(ca.litigated_actions, 0) AS litigated_actions,
        COALESCE(ca.divestiture_actions, 0) AS divestiture_actions,
        COALESCE(ca.injunction_actions, 0) AS injunction_actions,

        -- Calculated metrics
        CASE WHEN ce.total_criminal_fines > {{ var('criminal_fine_threshold') }} THEN TRUE ELSE FALSE END AS is_significant_fine,
        CASE
            WHEN c.status = 'CONVICTED' AND ce.criminal_defendants > 0 THEN 'CRIMINAL_SUCCESS'
            WHEN c.status = 'SETTLED' AND ca.settled_actions > 0 THEN 'CIVIL_SETTLEMENT'
            WHEN c.status = 'DISMISSED' THEN 'DISMISSED'
            WHEN c.status = 'OPEN' THEN 'PENDING'
            ELSE 'OTHER'
        END AS enforcement_outcome_type,

        -- Industry characteristics
        i.industry_code,
        i.is_highly_regulated,

        -- Violation characteristics
        v.statutory_basis,
        v.is_criminal_violation,
        v.enforcement_priority,

        now() AS _dbt_refreshed_at
    FROM cases c
    LEFT JOIN criminal_enforcement ce ON c.case_id = ce.case_id
    LEFT JOIN civil_actions ca ON c.case_id = ca.case_id
    LEFT JOIN industry_dim i ON c.industry_sector = i.industry_sector
    LEFT JOIN violation_dim v ON c.violation_type = v.violation_type
)

SELECT * FROM final