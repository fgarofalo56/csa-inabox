-- ==========================================================================
-- Gold Report: Threat Landscape
-- Summarizes threat activity by tactic, technique frequency, severity
-- distribution, and 30-day trends for executive dashboards.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH alerts AS (
    SELECT * FROM {{ ref('fct_security_alerts') }}
    WHERE time_generated >= DATEADD(DAY, -30, CURRENT_DATE())
),

-- Tactic summary
tactic_summary AS (
    SELECT
        tactic_name,
        COUNT(DISTINCT alert_id)                    AS alert_count,
        COUNT(DISTINCT technique_id)                AS unique_techniques,
        ROUND(AVG(composite_risk_score), 2)         AS avg_risk_score,
        MAX(severity_level)                         AS max_severity,
        MIN(time_generated)                         AS first_seen,
        MAX(time_generated)                         AS last_seen
    FROM alerts
    WHERE tactic_name IS NOT NULL
    GROUP BY tactic_name
),

-- Technique frequency (top 20)
technique_frequency AS (
    SELECT
        technique_id,
        technique_name,
        tactic_name,
        COUNT(DISTINCT alert_id)                    AS alert_count,
        ROUND(AVG(composite_risk_score), 2)         AS avg_risk_score,
        mitre_severity_tier
    FROM alerts
    WHERE technique_id IS NOT NULL
    GROUP BY technique_id, technique_name, tactic_name, mitre_severity_tier
    ORDER BY alert_count DESC
    LIMIT 20
),

-- Daily trend
daily_trend AS (
    SELECT
        CAST(time_generated AS DATE)                AS alert_date,
        COUNT(DISTINCT alert_id)                    AS daily_alert_count,
        SUM(CASE WHEN severity_level >= 3 THEN 1 ELSE 0 END) AS high_critical_count,
        ROUND(AVG(composite_risk_score), 2)         AS avg_daily_risk
    FROM alerts
    GROUP BY CAST(time_generated AS DATE)
),

-- Severity distribution
severity_dist AS (
    SELECT
        severity_label,
        severity_level,
        COUNT(DISTINCT alert_id)                    AS alert_count,
        ROUND(
            COUNT(DISTINCT alert_id) * 100.0 /
            NULLIF(SUM(COUNT(DISTINCT alert_id)) OVER (), 0),
            1
        )                                           AS pct_of_total
    FROM alerts
    GROUP BY severity_label, severity_level
)

-- Final union: tagged rows for dashboard consumption
SELECT 'tactic_summary'    AS report_section, TO_JSON(STRUCT(*)) AS payload FROM tactic_summary
UNION ALL
SELECT 'technique_freq'    AS report_section, TO_JSON(STRUCT(*)) AS payload FROM technique_frequency
UNION ALL
SELECT 'daily_trend'       AS report_section, TO_JSON(STRUCT(*)) AS payload FROM daily_trend
UNION ALL
SELECT 'severity_dist'     AS report_section, TO_JSON(STRUCT(*)) AS payload FROM severity_dist
