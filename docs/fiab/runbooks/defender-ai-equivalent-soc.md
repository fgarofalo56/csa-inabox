# Runbook — Defender AI equivalent SOC (health check)

## Context

In Gov boundaries where Defender for Cloud AI Threat Protection is
unavailable, CSA Loom ships a manual SOC pipeline (Sentinel + Content
Safety log wiring + self-hosted Presidio) per [Defender AI
workaround](../compliance/defender-ai-workaround.md).

This runbook is the quarterly health check for that pipeline.

## Check 1 — Sentinel DCR ingesting Loom Copilot telemetry

```kql
// In Sentinel workspace
LoomCopilotTelemetry
| where TimeGenerated > ago(24h)
| summarize events = count() by bin(TimeGenerated, 1h)
| render timechart
```

Expected: continuous event ingestion. If empty for > 1 hour →
investigate DCR.

```bash
# Verify DCR active
az monitor data-collection rule show \
  --name csa-loom-copilot-dcr \
  --resource-group <admin-plane-rg>

# Check DCR association to AppInsights
az monitor data-collection rule association list \
  --resource-group <admin-plane-rg>
```

## Check 2 — Analytics rules firing on test inputs

Inject synthetic test events that should trigger each analytics rule:

| Test | Expected trigger |
|---|---|
| Submit 20 PII-laden prompts within 15 min from one user | "Excessive PII redactions per user" |
| Submit 20 off-topic prompts within 15 min | "Off-topic refusals spike" |
| Submit prompt with > 50K output tokens | "Unusually long outputs" |
| Submit same prompt 50 times in 5 min | "High-rate same-prompt repetition" |
| Query 5+ sensitive workspaces within 10 min from one user | "Cross-workspace exfiltration pattern" |

For each test:
1. Inject via Console "Copilot" chat (or REST `/api/loom-chat`)
2. Wait 5-15 min for rule evaluation
3. Verify incident created in Sentinel
4. Verify incident severity matches expected

```bash
# List recent incidents
az sentinel incident list \
  --resource-group <admin-plane-rg> \
  --workspace-name <law-name> \
  --query "[?properties.createdTimeUtc > '2026-...']"
```

## Check 3 — Presidio PII detection working

```bash
# Health check Presidio sidecar
curl https://<presidio-url>/health
# Expected: {"status":"healthy"}

# Test detection
curl -X POST https://<presidio-url>/analyze \
  -H "Content-Type: application/json" \
  -d '{"text":"My SSN is 123-45-6789 and email is test@example.com","language":"en"}'
# Expected: detections for US_SSN + EMAIL_ADDRESS
```

## Check 4 — Workbook renders with realistic data

Open Loom Copilot SOC Dashboard workbook in Sentinel. Verify:
- Charts populated for last 24h
- Top users by activity
- Top redacted PII types
- Off-topic / refusal rate
- Cross-workspace access patterns

## Check 5 — Egress controls preventing AOAI cross-boundary calls

```bash
# Should fail: Loom Copilot trying to call commercial AOAI from Gov
# Use Container Apps / AKS log to verify outbound to *.openai.azure.com
# is blocked at NSG / Firewall layer
```

## Check 6 — Audit retention meets boundary requirement

| Boundary | Required retention |
|---|---|
| GCC-High / IL4 | 1 year minimum (federal audit) |
| IL5 | 7 years (CNSSI 1253) |

```bash
az monitor log-analytics workspace show \
  --resource-group <admin-plane-rg> \
  --workspace-name <law> \
  --query "retentionInDays"
```

## Remediation if checks fail

| Failed check | Action |
|---|---|
| DCR not ingesting | Re-bind DCR to Application Insights; verify managed identity |
| Analytics rule not firing | Re-enable rule; verify KQL still matches; update if Loom log schema changed |
| Presidio down | Restart container; verify NSG egress |
| Workbook broken | Re-deploy via Bicep `sentinel-ai-rules.bicep` |
| Retention too short | Update LAW retention setting; backfill from archive if available |

## Cadence

- **Quarterly** — full check sequence above
- **Monthly** — automated synthetic-event tests via GitHub Actions
  workflow
- **Continuous** — Sentinel itself surfaces failures via incident
  fire-rate metrics

## Related

- Compliance: [Defender AI workaround](../compliance/defender-ai-workaround.md)
- PRP: PRP-13 (Sentinel pipeline)
- Workload: [Copilot parity](../workloads/copilot-parity.md)
