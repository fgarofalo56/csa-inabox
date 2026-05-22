# Cybersecurity (MITRE ATT&CK) on CSA Loom

Endpoint telemetry + network logs + threat-hunting analytics with
KQL detection rules + threat-hunting Data Agent. Aligns with MITRE
ATT&CK framework. Federal cyber audience (CISA-aligned + per-agency
SOC).

## What you'll build

```
Source: Endpoint telemetry (Defender / Sentinel native sources)
        + Network logs (firewall / IDS / IPS)
        + Identity events (Entra audit logs)
    ↓ Sentinel + ADX continuous export to ADLS Gen2
Bronze: raw_endpoint_events, raw_network_events, raw_identity_events
    ↓ Databricks notebook — MITRE ATT&CK technique mapping
Silver: tagged_events (each tagged with ATT&CK technique IDs)
    ↓ ADX (additional cross-engine via shortcut for KQL ops)
KQL detection rules: per-technique detection logic
    ↓ Loom Activator Engine
Real-time SOC alerts: high-severity techniques → Teams + Logic App
    ↓ Loom Direct-Lake-Shim
Power BI semantic model (SOC dashboards, MITRE coverage map)
    ↓ Loom Data Agent (NL2KQL threat-hunt agent)
NL Q&A: "Show me lateral movement attempts last week"
        "Which endpoints had T1059 (Command and Scripting Interpreter)
         this month?"
```

## Components

| Loom capability | Used for |
|---|---|
| Sentinel + ADX continuous export | Bronze ingestion |
| Databricks notebook | ATT&CK technique enrichment |
| ADX | KQL detection rule store + query engine |
| Loom Activator Engine | SOC alert dispatcher |
| Power BI Premium | SOC dashboards |
| Loom Data Agent | Threat-hunt NL Q&A (NL2KQL) |

## Federal applicability

- Federal civilian SOC (CISA-aligned)
- DoD component SOC (defensive cyber operations)
- State + local government CJIS-aligned SOC
- Defense industrial base (CMMC L2/L3) SOC

Deploys in GCC-High for ITAR-eligible cyber data. IL5 for
classified SOC operations (v1.1).

## Sample KQL detection rule (T1059)

```kql
// MITRE ATT&CK T1059 — Command and Scripting Interpreter
TaggedEvents
| where TimeGenerated > ago(1h)
| where AttackTechniqueIds has "T1059"
| where ProcessName in ("powershell.exe", "cmd.exe", "pwsh.exe")
| where CommandLine matches regex @"(?i)(invoke-expression|iex|downloadstring|base64)"
| project TimeGenerated, EndpointName, UserPrincipalName,
          ProcessName, CommandLine, AttackTechniqueIds
| extend Severity = "High"
```

## Sample Activator rule (lateral movement)

```json
{
  "name": "Lateral movement detection",
  "dataSource": {
    "type": "adx-kql",
    "query": "TaggedEvents | where ts > ago(15m) | where AttackTechniqueIds has 'T1021' | summarize count() by EndpointName, bin(ts, 5m)",
    "splitColumn": "EndpointName",
    "cadenceMinutes": 1
  },
  "rules": [{
    "expression": {
      "operator": "isAbove",
      "attribute": "count_",
      "threshold": 5
    },
    "actions": [
      {"type": "teams-message", "channel": "#soc-high-sev",
       "template": "Endpoint {EndpointName} — lateral movement attempts: {count_} in 15 min"},
      {"type": "logic-app", "webhookUrl": "https://soc-incident-creator.azurewebsites.net/..."}
    ]
  }]
}
```

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Sentinel + Defender all plans |
| GCC | Same |
| GCC-High / IL4 | Sentinel + Defender (except AI Threat Protection); Loom Sentinel pipeline for SOC visibility |
| IL5 (v1.1) | Same as IL4; classified SOC workloads |

## Cost (F32 GCC-H baseline for federal SOC)

~$9,000/mo:
- Power BI Premium F32: $4,200
- ADX cluster (E16ds_v5): $1,500
- Sentinel (10 GB/day): $1,500
- Defender for Cloud per-workload: $500
- ADLS Gen2 (90-day hot, then cool): $400
- Databricks (analytics): $500
- AOAI (Data Agent): $200
- Misc: $200

## Source code

[`examples/fiab-cybersecurity/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-cybersecurity)

## Forward migration

ADX queries + dashboards port 1:1 to Fabric Eventhouse. Activator
rules port to Reflex. Sentinel remains the underlying SIEM.

## Related

- [Defender AI workaround](../compliance/defender-ai-workaround.md) —
  the Sentinel pipeline that replaces Defender AI Threat Protection
- [Sovereign AI Agents use case](../use-cases/sovereign-ai-agents.md)
- Existing source: [`examples/cybersecurity/`](../../examples/cybersecurity.md)
- Parent: [Federal Cybersecurity & Threat Analytics](../../use-cases/cybersecurity-threat-analytics.md)
