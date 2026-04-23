-- materialized='table': Full rebuild required for referential integrity
-- when new violation types are discovered.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'doj', 'dimension', 'violations']
  )
}}

/*
  Gold: Violation type dimension table.

  Provides standardized violation type codes, descriptions, and statutory
  references for antitrust enforcement analysis.
*/

WITH distinct_violations AS (
    SELECT DISTINCT violation_type
    FROM {{ ref('slv_antitrust_cases') }}
    WHERE is_valid = TRUE AND violation_type IS NOT NULL

    UNION

    SELECT DISTINCT offense_type AS violation_type
    FROM {{ ref('slv_criminal_enforcement') }}
    WHERE is_valid = TRUE AND offense_type IS NOT NULL
),

violations_with_metadata AS (
    SELECT
        {{ dbt_utils.generate_surrogate_key(['violation_type']) }} AS violation_sk,
        violation_type,
        CASE violation_type
            WHEN 'PRICE_FIXING' THEN 'Section 1 - Horizontal Agreement'
            WHEN 'BID_RIGGING' THEN 'Section 1 - Horizontal Agreement'
            WHEN 'MARKET_ALLOCATION' THEN 'Section 1 - Horizontal Agreement'
            WHEN 'MONOPOLIZATION' THEN 'Section 2 - Monopolization'
            WHEN 'ATTEMPTED_MONOPOLIZATION' THEN 'Section 2 - Attempted Monopolization'
            WHEN 'TYING' THEN 'Section 1 - Vertical Agreement'
            WHEN 'EXCLUSIVE_DEALING' THEN 'Section 1 - Vertical Agreement'
            WHEN 'MERGER_CHALLENGE' THEN 'Section 7 - Merger Review'
            WHEN 'CONSPIRACY' THEN 'Section 1 - Criminal Conspiracy'
            WHEN 'OBSTRUCTION' THEN 'Criminal Obstruction of Justice'
            ELSE 'Other Violation'
        END AS statutory_basis,
        CASE violation_type
            WHEN 'PRICE_FIXING' THEN 'Agreement among competitors to fix, raise, or stabilize prices'
            WHEN 'BID_RIGGING' THEN 'Conspiracy to rig bids, allocate contracts, or manipulate competitive bidding'
            WHEN 'MARKET_ALLOCATION' THEN 'Agreement among competitors to divide markets, territories, or customers'
            WHEN 'MONOPOLIZATION' THEN 'Unlawful acquisition or maintenance of monopoly power'
            WHEN 'ATTEMPTED_MONOPOLIZATION' THEN 'Attempt to acquire monopoly power through anticompetitive conduct'
            WHEN 'TYING' THEN 'Conditioning sale of one product on purchase of another'
            WHEN 'EXCLUSIVE_DEALING' THEN 'Agreements requiring exclusive purchasing or selling arrangements'
            WHEN 'MERGER_CHALLENGE' THEN 'Merger or acquisition that may substantially lessen competition'
            WHEN 'CONSPIRACY' THEN 'Criminal conspiracy to restrain trade or commerce'
            WHEN 'OBSTRUCTION' THEN 'Obstruction of antitrust investigation or proceeding'
            ELSE 'Other antitrust violation'
        END AS violation_description,
        CASE violation_type
            WHEN 'PRICE_FIXING' THEN 'Per Se'
            WHEN 'BID_RIGGING' THEN 'Per Se'
            WHEN 'MARKET_ALLOCATION' THEN 'Per Se'
            WHEN 'MONOPOLIZATION' THEN 'Rule of Reason'
            WHEN 'ATTEMPTED_MONOPOLIZATION' THEN 'Rule of Reason'
            WHEN 'TYING' THEN 'Modified Rule of Reason'
            WHEN 'EXCLUSIVE_DEALING' THEN 'Rule of Reason'
            WHEN 'MERGER_CHALLENGE' THEN 'Structural Analysis'
            WHEN 'CONSPIRACY' THEN 'Per Se'
            WHEN 'OBSTRUCTION' THEN 'Criminal Standard'
            ELSE 'Other'
        END AS legal_standard,
        CASE violation_type
            WHEN 'PRICE_FIXING' THEN TRUE
            WHEN 'BID_RIGGING' THEN TRUE
            WHEN 'MARKET_ALLOCATION' THEN TRUE
            WHEN 'CONSPIRACY' THEN TRUE
            WHEN 'OBSTRUCTION' THEN TRUE
            ELSE FALSE
        END AS is_criminal_violation,
        CASE violation_type
            WHEN 'PRICE_FIXING' THEN 'HIGH'
            WHEN 'BID_RIGGING' THEN 'HIGH'
            WHEN 'MARKET_ALLOCATION' THEN 'HIGH'
            WHEN 'MONOPOLIZATION' THEN 'MEDIUM'
            WHEN 'CONSPIRACY' THEN 'HIGH'
            WHEN 'MERGER_CHALLENGE' THEN 'MEDIUM'
            ELSE 'LOW'
        END AS enforcement_priority,
        now() AS _dbt_refreshed_at
    FROM distinct_violations
)

SELECT * FROM violations_with_metadata