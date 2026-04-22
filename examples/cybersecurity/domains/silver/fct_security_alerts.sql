-- ==========================================================================
-- Fact Model: Security Alerts (Normalized & Enriched)
-- Joins staged alerts with MITRE ATT&CK techniques for enriched analysis.
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='alert_id',
    schema='silver'
) }}

WITH staged_alerts AS (
    SELECT * FROM {{ ref('stg_sentinel_alerts') }}
),

-- Explode techniques array so each alert-technique pair gets a row
alert_techniques AS (
    SELECT
        a.alert_id,
        a.alert_name,
        a.severity,
        a.status,
        a.tactics,
        a.provider_name,
        a.time_generated,
        a.description,
        a.entities,
        a.remediation_steps,
        a.ingested_at,
        EXPLODE_OUTER(a.techniques)                 AS technique_id
    FROM staged_alerts a
),

enriched AS (
    SELECT
        at.alert_id,
        at.alert_name,
        at.provider_name,
        at.time_generated,
        at.description,
        at.status,
        at.remediation_steps,
        at.ingested_at,

        -- Normalized severity (numeric)
        CASE at.severity
            WHEN 'Critical'  THEN 4
            WHEN 'High'      THEN 3
            WHEN 'Medium'    THEN 2
            WHEN 'Low'       THEN 1
            ELSE 0
        END                                         AS severity_level,
        at.severity                                 AS severity_label,

        -- MITRE enrichment
        at.technique_id,
        mt.technique_name,
        mt.tactic_name,
        mt.severity_weight                          AS mitre_severity_weight,
        mt.severity_tier                            AS mitre_severity_tier,
        mt.detection_guidance,

        -- Tactics array
        at.tactics,

        -- Entity extraction
        FILTER(at.entities, x -> x.Type = 'Host')      AS host_entities,
        FILTER(at.entities, x -> x.Type = 'Account')   AS account_entities,
        FILTER(at.entities, x -> x.Type = 'IP')         AS ip_entities,

        -- Composite risk score: alert severity * MITRE weight
        ROUND(
            CASE at.severity
                WHEN 'Critical'  THEN 4
                WHEN 'High'      THEN 3
                WHEN 'Medium'    THEN 2
                WHEN 'Low'       THEN 1
                ELSE 0
            END * COALESCE(mt.severity_weight, 0.5),
            2
        )                                           AS composite_risk_score,

        CURRENT_TIMESTAMP()                         AS processed_at

    FROM alert_techniques at
    LEFT JOIN {{ ref('dim_mitre_techniques') }} mt
        ON at.technique_id = mt.technique_id
)

SELECT * FROM enriched

{% if is_incremental() %}
WHERE time_generated > (
    SELECT MAX(time_generated) FROM {{ this }}
)
{% endif %}
