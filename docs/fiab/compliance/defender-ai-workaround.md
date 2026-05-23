# Defender for Cloud AI Threat Protection workaround

> Microsoft Defender for Cloud AI Threat Protection is **Commercial-
> only**. Federal customers running AI workloads in Gov need
> equivalent SOC alerting via Azure Monitor + Microsoft Sentinel
> custom rules + manual Content Safety log wiring + self-hosted
> Presidio for PII.

## Context

Per `research/02-gov-boundary-availability.md §1`:
- Defender for Cloud — AI Threat Protection: ❌ **Commercial-only**
- Azure OpenAI Content Safety: ❌ **NOT at IL4 audit scope** in Gov
- Self-hosted Presidio: ✅ deployable in any boundary (open source)

CSA Loom's Loom Copilot + Loom Data Agents need equivalent SOC
visibility in Gov. The pipeline below substitutes.

## Architecture

```
Loom Copilot endpoint
  (azure-functions/copilot-chat/function_app.py)
        │
        │ per-turn telemetry: input length, output length,
        │ model invoked, PII detection results, Content Safety
        │ results (where available), off-topic / refusal detection,
        │ user session ID, conversation ID
        ▼
Application Insights (per-Admin-Plane)
        │
        │ Data Collection Rule (DCR) routes Copilot telemetry to
        │ dedicated Sentinel table
        ▼
Microsoft Sentinel workspace
  ├─ LoomCopilotTelemetry (custom table)
  ├─ Sentinel Analytics Rules:
  │   - "Excessive PII redactions per user" (N redactions/15-min)
  │   - "Off-topic refusals spike" (possible prompt injection)
  │   - "Unusually long outputs" (likely jailbreak attempt)
  │   - "High-rate same-prompt repetition" (likely bot/script)
  │   - "Cross-workspace exfiltration pattern" (user querying
  │     multiple sensitive workspaces in rapid sequence)
  └─ Workbook: "Loom Copilot SOC Dashboard"

Self-hosted Presidio (Gov-H / IL5):
  Container App (Commercial/GCC) or AKS workload (Gov-H/IL5)
  with Presidio analyzer for PII detection where Content Safety
  is unavailable.

  Loom Copilot calls Presidio side-car BEFORE the LLM:
        prompt → Presidio analyzer → redacted prompt → AOAI
        AOAI response → Presidio analyzer → redacted response → user
        All detections logged to App Insights → Sentinel
```

## Deployment

Per PRP-13:
- `platform/fiab/bicep/modules/admin-plane/sentinel-ai-rules.bicep`
  provisions the LAW table, DCR, analytics rules, and workbook
- `platform/fiab/bicep/modules/admin-plane/presidio-sidecar.bicep`
  deploys Presidio (conditional on Gov boundary)
- `azure-functions/copilot-chat/redaction.py` extended to emit
  telemetry on every PII detection
- `azure-functions/copilot-chat/telemetry.py` extended with new fields

## Sentinel analytics rules — KQL

### Excessive PII redactions per user

```kql
LoomCopilotTelemetry
| where TimeGenerated > ago(15m)
| where PII_DetectionCount > 0
| summarize total_redactions = sum(PII_DetectionCount)
            by UserPrincipalName, bin(TimeGenerated, 15m)
| where total_redactions > 20
```

Severity: Medium. Incident: "User <upn> triggered <N> PII redactions
in 15 min — investigate for misuse or data exfiltration attempt."

### Off-topic refusals spike (possible prompt injection)

```kql
LoomCopilotTelemetry
| where TimeGenerated > ago(15m)
| where AgentRefused == true
| summarize refusal_count = count()
            by UserPrincipalName, bin(TimeGenerated, 15m)
| where refusal_count > 20
```

Severity: Low. Incident: "User <upn> triggered <N> off-topic
refusals — possible prompt-injection campaign."

### Unusually long outputs (likely jailbreak)

```kql
LoomCopilotTelemetry
| where TimeGenerated > ago(1h)
| where OutputTokens > 50000
| project TimeGenerated, UserPrincipalName, ConversationId, OutputTokens
```

Severity: High. Incident: "User <upn> received <N>-token output —
investigate for jailbreak / data dump."

### High-rate same-prompt repetition (likely bot)

```kql
LoomCopilotTelemetry
| where TimeGenerated > ago(5m)
| summarize prompt_count = count(),
            unique_prompts = dcount(InputHash)
            by UserPrincipalName, bin(TimeGenerated, 5m)
| where prompt_count > 50 and unique_prompts < 5
```

Severity: Medium. Incident: "User <upn> issued <N> highly-similar
prompts in 5 min — likely bot or script."

### Cross-workspace exfiltration

```kql
LoomCopilotTelemetry
| where TimeGenerated > ago(10m)
| where AgentDataSource != ""
| summarize distinct_workspaces = dcount(WorkspaceId)
            by UserPrincipalName, bin(TimeGenerated, 10m)
| where distinct_workspaces >= 5
```

Severity: High. Incident: "User <upn> queried <N> distinct
sensitive workspaces in 10 min — investigate for exfiltration."

## Workbook

`Loom Copilot SOC Dashboard` (deployed by Bicep):
- Top users by activity
- Top PII detection types
- Off-topic / refusal rate over time
- Cross-workspace access heatmap
- Token consumption per user
- Per-tool-call latency

## Quarterly health check

See [Defender AI equivalent SOC runbook](../runbooks/defender-ai-equivalent-soc.md).

## Per-boundary applicability

| Boundary | Defender AI TP | Presidio | Sentinel pipeline |
|---|---|---|---|
| Commercial | ✅ use Defender natively | not needed | optional supplement |
| GCC | ✅ use Defender natively | not needed | optional supplement |
| GCC-High / IL4 | ❌ | ✅ deploy | ✅ deploy |
| IL5 (v1.1) | ❌ | ✅ deploy | ✅ deploy |

## Related

- ADR: [fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md)
- PRP: PRP-13 — Sentinel pipeline + Presidio
- Runbook: [Defender AI equivalent SOC](../runbooks/defender-ai-equivalent-soc.md)
- Workload: [Copilot parity](../workloads/copilot-parity.md), [Data Agents parity](../workloads/data-agents-parity.md)
- Memory: [[copilot-chat-two-backends]]
