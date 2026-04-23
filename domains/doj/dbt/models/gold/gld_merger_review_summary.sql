-- materialized='table': Full rebuild required for comprehensive merger review
-- analysis with complex HHI calculations and timeline metrics.
{{
  config(
    materialized='table',
    file_format='delta',
    tags=['gold', 'doj', 'merger', 'summary']
  )
}}

/*
  Gold: Merger review summary analysis.

  Provides comprehensive merger review statistics including HHI concentration
  analysis, review timelines, and outcome trends for policy analysis.
*/

WITH hsr_filings AS (
    SELECT
        fiscal_year,
        transaction_value,
        review_status,
        review_days,
        filing_fee
    FROM {{ ref('slv_hsr_filings') }}
    WHERE is_valid = TRUE
),

merger_reviews AS (
    SELECT
        fiscal_year,
        industry_sector,
        review_outcome,
        transaction_value,
        hhi_pre_merger,
        hhi_post_merger,
        hhi_delta,
        DATEDIFF('day', review_start_date, review_end_date) AS actual_review_days
    FROM {{ ref('slv_merger_reviews') }}
    WHERE is_valid = TRUE
),

filing_metrics_by_year AS (
    SELECT
        fiscal_year,
        COUNT(*) AS total_hsr_filings,
        COUNT(CASE WHEN review_status = 'GRANTED_ET' THEN 1 END) AS early_termination_granted,
        COUNT(CASE WHEN review_status = 'SECOND_REQUEST' THEN 1 END) AS second_requests_issued,
        COUNT(CASE WHEN review_status = 'CHALLENGED' THEN 1 END) AS transactions_challenged,
        COUNT(CASE WHEN review_status = 'ABANDONED' THEN 1 END) AS transactions_abandoned,
        SUM(transaction_value) AS total_transaction_value,
        AVG(transaction_value) AS avg_transaction_value,
        SUM(filing_fee) AS total_filing_fees,
        AVG(review_days) AS avg_review_days
    FROM hsr_filings
    GROUP BY fiscal_year
),

review_outcome_metrics AS (
    SELECT
        fiscal_year,
        COUNT(*) AS total_reviews,
        COUNT(CASE WHEN review_outcome = 'APPROVED' THEN 1 END) AS approved_reviews,
        COUNT(CASE WHEN review_outcome = 'CHALLENGED' THEN 1 END) AS challenged_reviews,
        COUNT(CASE WHEN review_outcome = 'CONSENT_DECREE' THEN 1 END) AS consent_decree_reviews,
        COUNT(CASE WHEN review_outcome = 'RESTRUCTURED' THEN 1 END) AS restructured_reviews,
        AVG(actual_review_days) AS avg_actual_review_days
    FROM merger_reviews
    GROUP BY fiscal_year
),

hhi_concentration_analysis AS (
    SELECT
        fiscal_year,
        -- Pre-merger concentration levels
        COUNT(CASE WHEN hhi_pre_merger < 1500 THEN 1 END) AS unconcentrated_markets,
        COUNT(CASE WHEN hhi_pre_merger BETWEEN 1500 AND 2500 THEN 1 END) AS moderately_concentrated_markets,
        COUNT(CASE WHEN hhi_pre_merger > {{ var('hhi_concentration_threshold') }} THEN 1 END) AS highly_concentrated_markets,

        -- HHI delta analysis
        AVG(hhi_delta) AS avg_hhi_increase,
        COUNT(CASE WHEN hhi_delta > 200 THEN 1 END) AS significant_concentration_increases,

        -- Post-merger concentration
        COUNT(CASE WHEN hhi_post_merger > {{ var('hhi_concentration_threshold') }} THEN 1 END) AS post_merger_highly_concentrated
    FROM merger_reviews
    WHERE hhi_pre_merger IS NOT NULL AND hhi_post_merger IS NOT NULL
    GROUP BY fiscal_year
),

industry_analysis AS (
    SELECT
        fiscal_year,
        COUNT(DISTINCT industry_sector) AS industries_reviewed,
        -- Top industries by review volume (simplified aggregation)
        SUM(CASE WHEN industry_sector IN ('HEALTHCARE', 'TECHNOLOGY', 'TELECOMMUNICATIONS') THEN 1 ELSE 0 END) AS top3_industry_reviews
    FROM merger_reviews
    GROUP BY fiscal_year
),

combined_summary AS (
    SELECT
        f.fiscal_year,

        -- Filing metrics
        f.total_hsr_filings,
        f.early_termination_granted,
        f.second_requests_issued,
        f.transactions_challenged AS filing_challenges,
        f.transactions_abandoned AS filing_abandonments,
        f.total_transaction_value,
        f.avg_transaction_value,
        f.total_filing_fees,
        f.avg_review_days AS avg_filing_review_days,

        -- Review outcome metrics
        COALESCE(r.total_reviews, 0) AS total_detailed_reviews,
        COALESCE(r.approved_reviews, 0) AS approved_reviews,
        COALESCE(r.challenged_reviews, 0) AS challenged_reviews,
        COALESCE(r.consent_decree_reviews, 0) AS consent_decree_reviews,
        COALESCE(r.restructured_reviews, 0) AS restructured_reviews,
        r.avg_actual_review_days,

        -- HHI concentration metrics
        COALESCE(h.unconcentrated_markets, 0) AS unconcentrated_markets,
        COALESCE(h.moderately_concentrated_markets, 0) AS moderately_concentrated_markets,
        COALESCE(h.highly_concentrated_markets, 0) AS highly_concentrated_markets,
        h.avg_hhi_increase,
        COALESCE(h.significant_concentration_increases, 0) AS significant_concentration_increases,
        COALESCE(h.post_merger_highly_concentrated, 0) AS post_merger_highly_concentrated,

        -- Industry diversity
        COALESCE(i.industries_reviewed, 0) AS industries_reviewed,
        COALESCE(i.top3_industry_reviews, 0) AS top3_industry_reviews,

        -- Calculated rates
        CASE WHEN f.total_hsr_filings > 0
            THEN ROUND((f.early_termination_granted * 100.0) / f.total_hsr_filings, 2)
            ELSE 0
        END AS early_termination_rate_pct,

        CASE WHEN f.total_hsr_filings > 0
            THEN ROUND((f.second_requests_issued * 100.0) / f.total_hsr_filings, 2)
            ELSE 0
        END AS second_request_rate_pct,

        CASE WHEN r.total_reviews > 0
            THEN ROUND((r.challenged_reviews * 100.0) / r.total_reviews, 2)
            ELSE 0
        END AS challenge_rate_pct,

        now() AS _dbt_refreshed_at

    FROM filing_metrics_by_year f
    LEFT JOIN review_outcome_metrics r ON f.fiscal_year = r.fiscal_year
    LEFT JOIN hhi_concentration_analysis h ON f.fiscal_year = h.fiscal_year
    LEFT JOIN industry_analysis i ON f.fiscal_year = i.fiscal_year
)

SELECT * FROM combined_summary
ORDER BY fiscal_year