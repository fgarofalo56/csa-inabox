# Synapse audit query pack — operator playbook

Every Synapse Serverless workspace in CSA Loom routes its SQL audit
events into the standardized Loom Log Analytics workspace via the
`SQLSecurityAuditEvents` diagnostic category + the `audit` /
`extendedAudit` settings provisioned by `landing-zone/synapse.bicep`.

This page is the KQL reference operators use against that LAW.

## Where the data lives

| Surface | LAW table | Source |
|---|---|---|
| SQL audit events | `SynapseSqlPoolSqlSecurityAuditLogs` | `audit` + `extendedAudit` policies; `BATCH_COMPLETED_GROUP` + auth + permission + schema-change action groups |
| Workspace RBAC ops | `SynapseRbacOperations` | Diagnostic setting category |
| Built-in Serverless SQL request lifecycle | `SynapseBuiltinSqlPoolRequestsEnded` | Diagnostic setting category |
| Integration pipeline runs | `SynapseIntegrationPipelineRuns` | Diagnostic setting category |
| Gateway API requests | `SynapseGatewayApiRequests` | Diagnostic setting category |

> Table names follow Azure Monitor's "resource-specific" mode (the
> default in our diagnostic-settings module). If your workspace was
> provisioned with "Azure diagnostics" mode instead, replace the
> resource-specific names below with `AzureDiagnostics | where
> ResourceProvider == 'MICROSOFT.SYNAPSE'` and project the relevant
> columns from the `properties_s` JSON.

## Core queries

### Failed authentications (last 24h)

```kql
SynapseSqlPoolSqlSecurityAuditLogs
| where TimeGenerated > ago(24h)
| where action_id_s == 'LGIF'   // FAILED_DATABASE_AUTHENTICATION_GROUP
| project TimeGenerated,
          server_principal_name_s,
          client_ip_s,
          application_name_s,
          succeeded_b,
          additional_information_s
| order by TimeGenerated desc
```

### Permission changes (least-privilege drift detection)

```kql
SynapseSqlPoolSqlSecurityAuditLogs
| where TimeGenerated > ago(7d)
| where action_id_s in ('GR', 'RV', 'DN', 'GRDC', 'RVDC', 'DNDC')
| project TimeGenerated,
          server_principal_name_s,
          object_name_s,
          statement_s,
          succeeded_b
| order by TimeGenerated desc
```

### Schema changes (drift from declared TMDL / Bicep)

```kql
SynapseSqlPoolSqlSecurityAuditLogs
| where TimeGenerated > ago(7d)
| where event_class_s in ('SCHEMA OBJECT CHANGE', 'SCHEMA_OBJECT_CHANGE')
| project TimeGenerated,
          server_principal_name_s,
          database_name_s,
          schema_name_s,
          object_name_s,
          statement_s
| order by TimeGenerated desc
```

### Top 10 most-used queries by principal (last 7d)

```kql
SynapseBuiltinSqlPoolRequestsEnded
| where TimeGenerated > ago(7d)
| where Status == 'Completed'
| summarize requestCount = count(),
            avgMs = avg(toint(DurationMs)),
            p95Ms = percentile(toint(DurationMs), 95),
            p99Ms = percentile(toint(DurationMs), 99)
            by Principal, bin_at = bin(TimeGenerated, 1d)
| top 10 by requestCount desc
```

### High-cost queries (Serverless billing unit = data scanned)

```kql
SynapseBuiltinSqlPoolRequestsEnded
| where TimeGenerated > ago(7d)
| where Status == 'Completed'
| extend dataScannedBytes = toint(DataProcessedBytes)
| summarize totalGB = sum(dataScannedBytes) / 1024 / 1024 / 1024,
            requestCount = count()
            by Principal, query = substring(Command, 0, 200)
| where totalGB > 10
| order by totalGB desc
```

### Queries that returned permission-denied errors

```kql
SynapseBuiltinSqlPoolRequestsEnded
| where TimeGenerated > ago(1d)
| where Status == 'Failed'
| extend errorCode = tostring(parse_json(ErrorDetails).Code)
| where errorCode in ('229', '230', '297', '15247')   // SQL Server permission-denied codes
| project TimeGenerated, Principal, Command, ErrorDetails
| order by TimeGenerated desc
```

## Drift detection

### Firewall-rule drift (declared in Bicep vs actual)

Used during weekly DSC drift checks. Compare with the `firewallRules`
param of `landing-zone/synapse.bicep`.

```kql
let bicepDeclaredRules = dynamic([
    'allow-vnet-only'
]);
SynapseRbacOperations
| where TimeGenerated > ago(7d)
| where OperationName contains 'firewallRules'
| extend ruleName = tostring(parse_json(Resource).name)
| where ruleName !in (bicepDeclaredRules)
| project TimeGenerated, Caller, OperationName, ruleName, ResultType
```

### Workspace RBAC drift (unexpected role assignments)

```kql
let bicepDeclaredRoles = dynamic([
    'Synapse Administrator',
    'Synapse SQL Administrator'
]);
SynapseRbacOperations
| where TimeGenerated > ago(7d)
| where OperationName endswith 'roleAssignments/write'
| extend role = tostring(parse_json(Resource).properties.roleName)
| where role !in (bicepDeclaredRoles)
| project TimeGenerated, Caller, role, Resource
```

## Suggested alert rules

These are Sentinel-ready KQL rules. Add them to
`platform/fiab/bicep/modules/admin-plane/monitoring.bicep` as
additional `Microsoft.SecurityInsights/alertRules` resources.

### Sustained failed authentication spike

```kql
SynapseSqlPoolSqlSecurityAuditLogs
| where TimeGenerated > ago(15m)
| where action_id_s == 'LGIF'
| summarize failedCount = count() by client_ip_s
| where failedCount > 20
```

Severity: High. Tactics: `CredentialAccess`.

### Permission grant outside of admin group

```kql
SynapseSqlPoolSqlSecurityAuditLogs
| where TimeGenerated > ago(1h)
| where action_id_s in ('GR', 'GRDC')
| where server_principal_name_s !in ('admins')   // adjust to your admin group name
| project TimeGenerated, server_principal_name_s, statement_s, object_name_s
```

Severity: Medium. Tactics: `PrivilegeEscalation`.

### Unexpected data exfil candidate

A single principal scans >100GB inside one hour — possible bulk
extract.

```kql
SynapseBuiltinSqlPoolRequestsEnded
| where TimeGenerated > ago(1h)
| where Status == 'Completed'
| extend dataGB = toint(DataProcessedBytes) / 1024 / 1024 / 1024
| summarize totalGB = sum(dataGB) by Principal
| where totalGB > 100
```

Severity: High. Tactics: `Exfiltration`.

## Cross-reference

- Bicep that provisions Synapse audit:
  [`platform/fiab/bicep/modules/landing-zone/synapse.bicep`](https://github.com/fgarofalo56/csa-inabox/blob/main/platform/fiab/bicep/modules/landing-zone/synapse.bicep)
- Diagnostic-settings helper:
  [`platform/fiab/bicep/modules/shared/diagnostic-settings.bicep`](https://github.com/fgarofalo56/csa-inabox/blob/main/platform/fiab/bicep/modules/shared/diagnostic-settings.bicep)
- Defender for AI workaround playbook: [Defender for AI equivalent SOC](defender-ai-equivalent-soc.md)
- CSA Loom monitoring runbook: [LAW monitoring + alert pack](loom-law-monitoring.md)

## Frequency

- Daily: failed-auth + permission-change queries (operator dashboard)
- Weekly: drift detection queries (compare with declared state)
- Continuous: Sentinel rules above fire automatically when conditions match
