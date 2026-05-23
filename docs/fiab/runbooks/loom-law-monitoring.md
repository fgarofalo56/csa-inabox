# Loom LAW monitoring + alert pack

The standardized Loom Log Analytics workspace (`law-csa-loom-<region>`
in the Admin Plane RG) is the single observability surface for the
entire CSA Loom stack. This runbook is the operator query catalog —
copy-pasteable KQL for the most-used investigations.

## Quick health check — every service in one query

```kql
let services = dynamic([
    'loom-console','loom-orchestrator','loom-copilot','loom-activator',
    'loom-mirroring','loom-direct-lake-shim','loom-mcp','loom-presidio-analyzer',
    'loom-presidio-anonymizer'
]);
AppRequests
| where TimeGenerated > ago(15m)
| where AppRoleName in (services)
| summarize
    requestCount = count(),
    successCount = countif(Success == true),
    failureCount = countif(Success == false),
    p50ms = percentile(DurationMs, 50),
    p95ms = percentile(DurationMs, 95),
    p99ms = percentile(DurationMs, 99)
    by AppRoleName
| extend successRate = round(100.0 * successCount / requestCount, 1)
| order by AppRoleName asc
```

Use as your morning standup dashboard.

## Per-service deep dives

### Loom Console — auth + RLS

```kql
AppRequests
| where AppRoleName == 'loom-console'
| where TimeGenerated > ago(1h)
| where Name startswith 'GET /api/workspaces' or Name startswith 'POST /api/workspaces'
| summarize
    requests = count(),
    auth401 = countif(ResultCode == '401'),
    auth403 = countif(ResultCode == '403'),
    server500 = countif(ResultCode startswith '5')
    by Name, bin(TimeGenerated, 5m)
| render timechart
```

### Loom Activator — fired rules over time

```kql
AppEvents
| where AppRoleName == 'loom-activator'
| where Name == 'rule.fired'
| extend ruleId = tostring(Properties.ruleId),
         primitive = tostring(Properties.primitive)
| summarize fireCount = count() by primitive, bin(TimeGenerated, 15m)
| render timechart
```

### Loom Mirroring — CDC lag

The replicator emits a `mirror.lag_seconds` custom metric each
microbatch. Spikes above 60s indicate the replicator can't keep up;
escalate per [Mirroring CDC lag](mirroring-cdc-lag.md) runbook.

```kql
AppMetrics
| where Name == 'mirror.lag_seconds'
| where TimeGenerated > ago(1h)
| extend mirrorId = tostring(Properties['csa-loom.mirror_id'])
| summarize maxLag = max(Sum / Count) by mirrorId, bin(TimeGenerated, 1m)
| render timechart
```

### Loom Direct-Lake Shim — refresh latency SLA

The shim emits `refresh.duration_ms` per partition refresh. The SLA
gate is `MaxStalenessSeconds` declared in the Cosmos
`refresh-policies` container.

```kql
AppMetrics
| where Name == 'refresh.duration_ms'
| where TimeGenerated > ago(6h)
| extend modelId = tostring(Properties.semanticModelId),
         tableName = tostring(Properties.tableName)
| summarize p50ms = percentile(Sum, 50), p95ms = percentile(Sum, 95), maxMs = max(Sum)
    by modelId, tableName, bin(TimeGenerated, 5m)
| where p95ms > 30000   // honest gap: 5-30s; sustained >30s = investigate
```

### Loom Data Agents — NL2SQL accuracy proxy

Counts the fraction of generated SQL that succeeded vs failed at the
engine layer. Sustained drop = AOAI model behavior change OR schema
drift not propagated to the per-agent schema registration.

```kql
AppDependencies
| where AppRoleName == 'loom-copilot'
| where Name == 'tool.nl2sql.execute_sql'
| summarize
    attempts = count(),
    successes = countif(Success == true)
    by bin(TimeGenerated, 1h)
| extend successRate = round(100.0 * successes / attempts, 1)
| render timechart
```

## Cross-service correlation

### Trace a single Setup Wizard deployment end-to-end

```kql
let deploymentId = 'PASTE-HERE';
union AppRequests, AppDependencies, AppEvents, AppExceptions, AppTraces
| where TimeGenerated > ago(2h)
| where customDimensions has deploymentId
   or  Properties has deploymentId
   or  Message has deploymentId
| project TimeGenerated, AppRoleName, ItemType, Name, Success, ResultCode, Message
| order by TimeGenerated asc
```

Pairs with `/api/setup/{deployment_id}/sse` for the UI side.

### Find the slowest user across all services

```kql
AppRequests
| where TimeGenerated > ago(1d)
| extend userOid = tostring(customDimensions.user_oid)
| where isnotempty(userOid)
| summarize
    requestCount = count(),
    p95ms = percentile(DurationMs, 95),
    p99ms = percentile(DurationMs, 99)
    by userOid, AppRoleName
| top 20 by p95ms desc
```

## Cost monitoring

### LAW ingestion by service (last 7d, GB)

```kql
Usage
| where TimeGenerated > ago(7d)
| where IsBillable == true
| summarize totalGB = sum(Quantity) / 1024 by Solution, DataType
| top 20 by totalGB desc
```

Triggers a budget review if any single service > 5GB/day sustained.

### Daily LAW spend trend

```kql
Usage
| where TimeGenerated > ago(30d)
| where IsBillable == true
| summarize gbIngested = sum(Quantity) / 1024 by bin(TimeGenerated, 1d)
| render timechart
```

## Suggested alert rules (Sentinel-ready)

These extend the AI-defense rules already provisioned by
`monitoring.bicep`. Add via additional `Microsoft.SecurityInsights/
alertRules` resources.

### Service down (no requests in 5 min)

```kql
let services = dynamic([
    'loom-console','loom-orchestrator','loom-mcp','loom-activator',
    'loom-mirroring','loom-direct-lake-shim'
]);
AppRequests
| where TimeGenerated > ago(5m)
| where AppRoleName in (services)
| summarize requestCount = count() by AppRoleName
| join kind=rightouter (datatable(AppRoleName:string) services
    | extend hint = 1) on AppRoleName
| where isnull(requestCount) or requestCount == 0
```

Severity: High. Triggers AI-defense playbook (extends existing).

### Activator action-dispatch failures

```kql
AppExceptions
| where AppRoleName == 'loom-activator'
| where OuterMessage has 'Action dispatch failed'
| summarize failureCount = count() by bin(TimeGenerated, 5m)
| where failureCount > 5
```

### Direct-Lake refresh SLA violation (sustained)

```kql
AppMetrics
| where Name == 'refresh.duration_ms'
| where TimeGenerated > ago(15m)
| extend modelId = tostring(Properties.semanticModelId)
| summarize p95ms = percentile(Sum, 95) by modelId
| where p95ms > 60000   // sustained > 60s (2x the honest gap)
```

## Related

- [Synapse audit query pack](synapse-audit-query-pack.md)
- [Defender for AI equivalent SOC](defender-ai-equivalent-soc.md)
- [Mirroring CDC lag](mirroring-cdc-lag.md)
- [Direct-Lake Shim stuck](direct-lake-shim-stuck.md)
- Bicep:
  [`platform/fiab/bicep/modules/admin-plane/monitoring.bicep`](https://github.com/fgarofalo56/csa-inabox/blob/main/platform/fiab/bicep/modules/admin-plane/monitoring.bicep)
- Helper:
  [`platform/fiab/bicep/modules/shared/diagnostic-settings.bicep`](https://github.com/fgarofalo56/csa-inabox/blob/main/platform/fiab/bicep/modules/shared/diagnostic-settings.bicep)
