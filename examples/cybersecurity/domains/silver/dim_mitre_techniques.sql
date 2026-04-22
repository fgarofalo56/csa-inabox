-- ==========================================================================
-- Dimension Model: MITRE ATT&CK Techniques
-- Provides technique reference data for alert enrichment and reporting.
-- ==========================================================================

{{ config(
    materialized='table',
    schema='silver'
) }}

WITH raw_techniques AS (
    SELECT
        id                  AS technique_id,
        name                AS technique_name,
        tactic              AS tactic_name,
        platform            AS platforms,
        detection           AS detection_guidance,
        severity_weight     AS severity_weight,
        data_sources        AS data_sources
    FROM {{ source('mitre_reference', 'mitre_attack_mapping') }}
),

enriched AS (
    SELECT
        technique_id,
        technique_name,
        tactic_name,

        -- Extract parent technique ID (e.g., T1059 from T1059.001)
        CASE
            WHEN CONTAINS(technique_id, '.')
            THEN SUBSTRING(technique_id, 1, INSTR(technique_id, '.') - 1)
            ELSE technique_id
        END                                         AS parent_technique_id,

        -- Flag sub-techniques
        CONTAINS(technique_id, '.')                 AS is_sub_technique,

        platforms,
        detection_guidance,
        severity_weight,
        data_sources,

        -- Severity tier based on weight
        CASE
            WHEN severity_weight >= 0.9 THEN 'Critical'
            WHEN severity_weight >= 0.7 THEN 'High'
            WHEN severity_weight >= 0.5 THEN 'Medium'
            ELSE 'Low'
        END                                         AS severity_tier,

        CURRENT_TIMESTAMP()                         AS updated_at

    FROM raw_techniques
)

SELECT * FROM enriched
