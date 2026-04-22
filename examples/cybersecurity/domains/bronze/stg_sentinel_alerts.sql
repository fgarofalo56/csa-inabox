-- ==========================================================================
-- Staging Model: Raw Sentinel Alerts
-- Source: Bronze layer - raw JSON alerts from Azure Sentinel
-- ==========================================================================

{{ config(
    materialized='incremental',
    unique_key='alert_id',
    schema='bronze'
) }}

SELECT
    AlertId                                         AS alert_id,
    AlertName                                       AS alert_name,
    CAST(Severity AS STRING)                        AS severity,
    CAST(Status AS STRING)                          AS status,
    Tactics                                         AS tactics,
    Techniques                                      AS techniques,
    ProviderName                                    AS provider_name,
    CAST(TimeGenerated AS TIMESTAMP)                AS time_generated,
    Description                                     AS description,
    Entities                                        AS entities,
    RemediationSteps                                AS remediation_steps,
    CURRENT_TIMESTAMP()                             AS ingested_at,
    input_file_name()                               AS source_file

FROM {{ source('sentinel_raw', 'raw_sentinel_alerts') }}

{% if is_incremental() %}
WHERE CAST(TimeGenerated AS TIMESTAMP) > (
    SELECT MAX(time_generated) FROM {{ this }}
)
{% endif %}
