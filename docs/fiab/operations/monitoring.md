# Monitoring & observability

CSA Loom uses Application Insights + Log Analytics + Microsoft
Sentinel (Gov) as the telemetry backbone. The Loom Console
"Monitoring Hub" pane is the unified UX.

## Telemetry sources

| Source | Sink |
|---|---|
| Loom Console (browser) | App Insights via `javascripts/app-insights.js` |
| Loom Console BFF | App Insights server-side |
| Loom Setup Wizard | App Insights + Activity Log |
| Loom Copilot | App Insights (per-turn telemetry per `azure-functions/copilot-chat/telemetry.py`) |
| MCP server tool calls | Activity Log + App Insights with correlation IDs |
| Loom Activator Engine | App Insights + Sentinel |
| Loom Mirroring Engine | App Insights + Databricks Spark UI |
| Loom Direct-Lake-Shim | App Insights + TOM refresh logs |
| Databricks workspaces | System tables → exported to LAW |
| Synapse Serverless | Synapse diagnostics → LAW |
| ADX | Native KQL on the cluster + diagnostic logs → LAW |
| Power BI Premium | Power BI activity log + capacity metrics |
| Purview | Activity log → LAW |
| ADLS Gen2 | Storage diagnostics → LAW |
| Container Apps / AKS | Container insights → LAW |

## Monitoring Hub UI

The Console "Monitoring" pane aggregates the above:

- **Capacity utilization** — CU-equivalent dashboard (see [Capacity management](capacity-management.md))
- **Query history** — unified across Databricks SQL, Synapse, ADX,
  Power BI XMLA
- **Deploy history** — every MCP-mediated deploy + Bicep diff
- **Activator firing log**
- **Mirroring lag**
- **Cost dashboard** — Azure Cost Management API integration
- **Audit log search** — Sentinel-backed in Gov

## Pre-built KQL queries

Ships in `docs/fiab/operations/queries.kql` (referenced from the
Console Monitoring Hub).

### Capacity utilization (CU-equivalent) over last 24h

```kql
let dbx = DatabricksClusterEvents
  | where TimeGenerated > ago(24h)
  | summarize dbu = sum(dbuConsumed) by bin(TimeGenerated, 5m);
let ad = ADXIngestionEvents
  | summarize vcs = sum(vcoreSeconds) by bin(TimeGenerated, 5m);
let pbi = PowerBICapacityEvents
  | summarize memMb = max(memoryMb) by bin(TimeGenerated, 5m);
let aoai = ContainerLogsForCopilotChat
  | where Message contains "openai-tokens-out"
  | summarize tpm = sum(tokens) by bin(TimeGenerated, 5m);
union dbx, ad, pbi, aoai
| summarize cu_estimate = (dbu * 16) + (vcs / 60) + (memMb / 1024) + (tpm / 50000)
            by bin(TimeGenerated, 5m)
```

### Direct-Lake-Shim refresh latency

```kql
TraceLogs
| where Category == "DirectLakeShim"
| where Message contains "RefreshComplete"
| extend latency_seconds = todouble(extract(@"latencySeconds=(\d+\.?\d*)", 1, Message))
| summarize p50 = percentile(latency_seconds, 50),
            p95 = percentile(latency_seconds, 95)
            by bin(TimeGenerated, 1h)
```

### Activator rule firing count

```kql
ActivatorEngineLogs
| where Category == "RuleFiring"
| summarize firings = count() by RuleId, bin(TimeGenerated, 1h)
```

### Mirroring CDC lag per source

```kql
MirroringEngineLogs
| where Category == "CDCLag"
| extend lag_seconds = todouble(extract(@"lagSeconds=(\d+)", 1, Message))
| summarize p95_lag = percentile(lag_seconds, 95)
            by sourceType, bin(TimeGenerated, 5m)
```

### Loom Copilot error rate

```kql
CopilotChatLogs
| where TimeGenerated > ago(24h)
| summarize errors = countif(severity == "Error"),
            total = count()
            by bin(TimeGenerated, 1h)
| extend error_rate = errors * 100.0 / total
```

## Sentinel (Gov)

In Gov boundaries (GCC-H / IL5), Loom Copilot telemetry is also
routed to Microsoft Sentinel via a custom DCR (Data Collection Rule)
per [Defender AI workaround](../compliance/defender-ai-workaround.md).

Sentinel analytics rules:
- Excessive PII redactions per user
- Off-topic refusals spike (possible prompt injection)
- Unusually long outputs (likely jailbreak)
- High-rate same-prompt repetition (likely bot)
- Cross-workspace exfiltration patterns

## Custom dashboards

The Monitoring Hub also accepts custom KQL queries + workbooks. Save
your org-specific queries to Cosmos DB via the Console "Save query"
action.

## Related

- [Capacity management](capacity-management.md)
- [Cost management](cost.md)
- [Defender AI workaround](../compliance/defender-ai-workaround.md)
- Parent: [Monitoring & Observability best practices](../../best-practices/monitoring-observability.md)
