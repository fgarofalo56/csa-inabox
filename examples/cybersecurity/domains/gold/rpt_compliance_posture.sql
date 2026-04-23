-- ==========================================================================
-- Gold Report: Compliance Posture
-- Maps security alerts to CMMC/NIST 800-53 controls and produces gap
-- analysis with remediation priority scoring.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='gold'
) }}

WITH control_mapping AS (
    -- Static mapping of MITRE tactics to NIST 800-53 control families
    SELECT * FROM (VALUES
        ('Initial Access',        'AC',  'Access Control',             'AC-17', 'Remote Access'),
        ('Execution',             'SI',  'System and Information Integrity', 'SI-3',  'Malicious Code Protection'),
        ('Persistence',           'CM',  'Configuration Management',   'CM-7',  'Least Functionality'),
        ('Privilege Escalation',  'AC',  'Access Control',             'AC-6',  'Least Privilege'),
        ('Defense Evasion',       'SI',  'System and Information Integrity', 'SI-4',  'System Monitoring'),
        ('Credential Access',     'IA',  'Identification and Authentication', 'IA-5', 'Authenticator Management'),
        ('Lateral Movement',      'AC',  'Access Control',             'AC-4',  'Information Flow Enforcement'),
        ('Collection',            'MP',  'Media Protection',           'MP-5',  'Media Transport'),
        ('Exfiltration',          'SC',  'System and Communications Protection', 'SC-7', 'Boundary Protection'),
        ('Command and Control',   'SC',  'System and Communications Protection', 'SC-7', 'Boundary Protection'),
        ('Impact',                'CP',  'Contingency Planning',       'CP-9',  'System Backup')
    ) AS t(tactic_name, control_family_id, control_family_name, control_id, control_name)
),

alert_metrics AS (
    SELECT
        tactic_name,
        COUNT(DISTINCT alert_id)                    AS alert_count,
        MAX(severity_level)                         AS max_severity,
        ROUND(AVG(composite_risk_score), 2)         AS avg_risk_score,
        MAX(time_generated)                         AS latest_alert
    FROM {{ ref('fct_security_alerts') }}
    WHERE time_generated >= DATEADD(DAY, -30, CURRENT_DATE())
      AND tactic_name IS NOT NULL
    GROUP BY tactic_name
),

posture AS (
    SELECT
        cm.control_family_id,
        cm.control_family_name,
        cm.control_id,
        cm.control_name,
        cm.tactic_name                              AS associated_tactic,
        COALESCE(am.alert_count, 0)                 AS alert_count_30d,
        COALESCE(am.max_severity, 0)                AS max_severity,
        COALESCE(am.avg_risk_score, 0)              AS avg_risk_score,
        am.latest_alert,

        -- Compliance status based on alert activity
        CASE
            WHEN am.alert_count IS NULL THEN 'No Activity'
            WHEN am.max_severity >= 3    THEN 'At Risk'
            WHEN am.alert_count > 5      THEN 'Needs Review'
            ELSE 'Monitored'
        END                                         AS compliance_status,

        -- Remediation priority: higher = more urgent
        ROUND(
            COALESCE(am.avg_risk_score, 0) * LOG2(COALESCE(am.alert_count, 0) + 1),
            2
        )                                           AS remediation_priority,

        CURRENT_TIMESTAMP()                         AS assessed_at
    FROM control_mapping cm
    LEFT JOIN alert_metrics am ON cm.tactic_name = am.tactic_name
)

SELECT * FROM posture
ORDER BY remediation_priority DESC
