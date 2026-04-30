# Monitoring & Observability Migration

**Establish comprehensive monitoring for the SAS-to-Entra authentication migration, including Entra sign-in logs, certificate expiration alerts, and authentication dashboards.**

> **Finding:** CSA-0025 (HIGH, BREAKING) | **Ballot:** AQ-0014 (approved)

---

## Overview

Monitoring is critical during and after a security migration. Before migration, you need a baseline of current SAS authentication patterns. During migration, you need real-time visibility into both SAS and Entra authentication to ensure devices and services are transitioning correctly. After migration, you need ongoing monitoring of certificate lifetimes, managed identity usage, and authentication failures.

---

## Pre-migration baseline

### Enable IoT Hub diagnostic settings

Before starting the migration, ensure diagnostic settings are configured to capture authentication events.

```bash
# Enable diagnostic settings on IoT Hub
az monitor diagnostic-settings create \
  --name "iot-hub-auth-diagnostics" \
  --resource "$IOT_HUB_ID" \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --logs '[
    {"category": "Connections", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "DeviceTelemetry", "enabled": true, "retentionPolicy": {"days": 30, "enabled": true}},
    {"category": "C2DCommands", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "DeviceIdentityOperations", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "Routes", "enabled": true, "retentionPolicy": {"days": 30, "enabled": true}},
    {"category": "D2CTwinOperations", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "C2DTwinOperations", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "TwinQueries", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "DirectMethods", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "Configurations", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}}
  ]' \
  --metrics '[{"category": "AllMetrics", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}}]'
```

### Baseline KQL query: Current SAS authentication patterns

```kql
// Count connections by auth type over the last 7 days
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(7d)
| extend authType = tostring(properties_s)
| summarize
    TotalConnections = count(),
    UniqueDevices = dcount(deviceId_s)
    by authType_s
| order by TotalConnections desc
```

```kql
// Identify devices still using SAS authentication
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(24h)
| where authType_s == "sas"
| summarize
    LastConnection = max(TimeGenerated),
    ConnectionCount = count()
    by deviceId_s
| order by LastConnection desc
```

---

## Entra sign-in logs for IoT Hub access

### Enable Entra diagnostic settings

```bash
# Enable Entra ID diagnostic settings to Log Analytics
az monitor diagnostic-settings create \
  --name "entra-iot-diagnostics" \
  --resource "/providers/Microsoft.aadiam/diagnosticSettings/entra-iot" \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --logs '[
    {"category": "SignInLogs", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "NonInteractiveUserSignInLogs", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "ServicePrincipalSignInLogs", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "ManagedIdentitySignInLogs", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "AuditLogs", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}}
  ]'
```

### KQL: Managed identity sign-ins to IoT Hub

```kql
// Managed identity authentications to IoT Hub
ManagedIdentitySignInLogs
| where TimeGenerated > ago(24h)
| where ResourceDisplayName contains "IoT Hub"
    or ResourceId contains "Microsoft.Devices/IotHubs"
| project
    TimeGenerated,
    ServicePrincipalName,
    ServicePrincipalId,
    ResourceDisplayName,
    IPAddress,
    Status = ResultType,
    ConditionalAccessStatus
| order by TimeGenerated desc
```

```kql
// Failed managed identity authentications (potential RBAC issues)
ManagedIdentitySignInLogs
| where TimeGenerated > ago(24h)
| where ResultType != "0"  // Non-success
| where ResourceDisplayName contains "IoT Hub"
| project
    TimeGenerated,
    ServicePrincipalName,
    ResultType,
    ResultDescription,
    IPAddress
| order by TimeGenerated desc
```

---

## Certificate expiration monitoring

### Azure Monitor alert for certificate expiration

```bash
# Create alert rule for certificates expiring within 30 days
az monitor scheduled-query create \
  --name "iot-cert-expiry-warning" \
  --resource-group "$RG" \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count > 0" \
  --condition-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.DEVICES'
    | where Category == 'Connections'
    | where TimeGenerated > ago(1h)
    | where authType_s == 'x509'
    | extend certExpiry = todatetime(properties_s)
    | where certExpiry < now() + 30d
    | summarize count() by deviceId_s, certExpiry
  " \
  --evaluation-frequency "1h" \
  --window-size "1h" \
  --severity 2 \
  --action-groups "$ACTION_GROUP_ID" \
  --description "IoT device certificates expiring within 30 days"
```

### KQL: Certificate expiration dashboard

```kql
// Certificates expiring in the next 90 days
let CertInventory = datatable(deviceId:string, certThumbprint:string, certExpiry:datetime) [
    // This would be populated from your certificate management system
    // or extracted from IoT Hub device registry
];
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where authType_s == "x509"
| where TimeGenerated > ago(24h)
| summarize LastSeen = max(TimeGenerated) by deviceId_s
| join kind=inner (
    // Join with certificate inventory
    CertInventory
) on $left.deviceId_s == $right.deviceId
| extend DaysUntilExpiry = datetime_diff('day', certExpiry, now())
| extend ExpiryBucket = case(
    DaysUntilExpiry <= 0, "EXPIRED",
    DaysUntilExpiry <= 7, "Critical (< 7 days)",
    DaysUntilExpiry <= 30, "Warning (< 30 days)",
    DaysUntilExpiry <= 90, "Upcoming (< 90 days)",
    "OK (90+ days)"
)
| summarize DeviceCount = count() by ExpiryBucket
| order by DeviceCount desc
```

### Key Vault certificate expiration monitoring

If certificates are managed through Azure Key Vault:

```bash
# Enable Key Vault diagnostic settings
az monitor diagnostic-settings create \
  --name "kv-cert-diagnostics" \
  --resource "$KEY_VAULT_ID" \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --logs '[
    {"category": "AuditEvent", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}}
  ]'

# Create alert for Key Vault certificate near expiry events
az monitor scheduled-query create \
  --name "kv-cert-expiry-alert" \
  --resource-group "$RG" \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count > 0" \
  --condition-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.KEYVAULT'
    | where OperationName == 'CertificateNearExpiry'
    | project TimeGenerated, id_s, requestUri_s
  " \
  --evaluation-frequency "6h" \
  --window-size "6h" \
  --severity 2 \
  --action-groups "$ACTION_GROUP_ID" \
  --description "Key Vault certificates approaching expiration"
```

---

## Managed identity usage auditing

### KQL: Managed identity usage patterns

```kql
// Which managed identities are accessing IoT Hub and how often
ManagedIdentitySignInLogs
| where TimeGenerated > ago(7d)
| where ResourceDisplayName contains "IoT Hub"
| summarize
    AuthCount = count(),
    SuccessCount = countif(ResultType == "0"),
    FailureCount = countif(ResultType != "0"),
    LastAccess = max(TimeGenerated),
    DistinctIPs = dcount(IPAddress)
    by ServicePrincipalName, ServicePrincipalId
| extend FailureRate = round(100.0 * FailureCount / AuthCount, 2)
| order by AuthCount desc
```

```kql
// Unused managed identities (assigned RBAC but no sign-ins in 30 days)
let ActiveIdentities = ManagedIdentitySignInLogs
| where TimeGenerated > ago(30d)
| where ResourceDisplayName contains "IoT Hub"
| distinct ServicePrincipalId;
// Cross-reference with RBAC assignments via Azure Resource Graph
// (requires Resource Graph query integration)
AzureActivity
| where OperationNameValue == "Microsoft.Authorization/roleAssignments/write"
| where TimeGenerated > ago(90d)
| where Properties_d contains "Microsoft.Devices/IotHubs"
| extend AssignedPrincipalId = tostring(parse_json(Properties_d).principalId)
| where AssignedPrincipalId !in (ActiveIdentities)
| project AssignedPrincipalId, OperationName, TimeGenerated
```

---

## Dashboard template

### Migration progress dashboard (KQL queries)

```kql
// === Panel 1: Migration Progress ===
// Devices by authentication type over time
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(30d)
| summarize DeviceCount = dcount(deviceId_s) by bin(TimeGenerated, 1d), authType_s
| render timechart with (title="Device Auth Type Over Time")
```

```kql
// === Panel 2: Current Auth Type Distribution ===
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(24h)
| summarize DeviceCount = dcount(deviceId_s) by authType_s
| render piechart with (title="Current Auth Type Distribution")
```

```kql
// === Panel 3: Authentication Failures ===
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(24h)
| where level_s == "Error" or statusCode_s startswith "4"
| summarize FailureCount = count() by bin(TimeGenerated, 1h), authType_s
| render timechart with (title="Auth Failures by Type")
```

```kql
// === Panel 4: Service Identity Usage ===
ManagedIdentitySignInLogs
| where TimeGenerated > ago(24h)
| where ResourceDisplayName contains "IoT Hub"
| summarize
    Total = count(),
    Failures = countif(ResultType != "0")
    by bin(TimeGenerated, 1h)
| render timechart with (title="Service Identity Auth Events")
```

```kql
// === Panel 5: Certificate Health ===
// Requires certificate inventory table (custom)
// Simulated with connection log data
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where authType_s == "x509"
| where TimeGenerated > ago(1h)
| summarize
    ConnectedDevices = dcount(deviceId_s),
    TotalConnections = count()
| extend Status = iff(ConnectedDevices > 0, "Healthy", "No X.509 connections")
```

```kql
// === Panel 6: Remaining SAS Devices ===
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.DEVICES"
| where Category == "Connections"
| where TimeGenerated > ago(24h)
| where authType_s == "sas"
| distinct deviceId_s
| summarize RemainingDevices = count()
```

---

## Alert rules for authentication failures

### Alert 1: High rate of authentication failures

```bash
az monitor scheduled-query create \
  --name "iot-auth-failure-spike" \
  --resource-group "$RG" \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count > 50" \
  --condition-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.DEVICES'
    | where Category == 'Connections'
    | where statusCode_s startswith '4'
    | where TimeGenerated > ago(15m)
    | summarize FailureCount = count()
  " \
  --evaluation-frequency "5m" \
  --window-size "15m" \
  --severity 1 \
  --action-groups "$ACTION_GROUP_ID" \
  --description "More than 50 IoT Hub auth failures in 15 minutes"
```

### Alert 2: SAS authentication detected after migration

```bash
az monitor scheduled-query create \
  --name "iot-sas-after-migration" \
  --resource-group "$RG" \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count > 0" \
  --condition-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.DEVICES'
    | where Category == 'Connections'
    | where authType_s == 'sas'
    | where TimeGenerated > ago(1h)
    | summarize count()
  " \
  --evaluation-frequency "1h" \
  --window-size "1h" \
  --severity 2 \
  --action-groups "$ACTION_GROUP_ID" \
  --description "SAS authentication detected after migration cutover"
```

### Alert 3: Managed identity authentication failure

```bash
az monitor scheduled-query create \
  --name "iot-mi-auth-failure" \
  --resource-group "$RG" \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count > 0" \
  --condition-query "
    ManagedIdentitySignInLogs
    | where ResultType != '0'
    | where ResourceDisplayName contains 'IoT Hub'
    | where TimeGenerated > ago(15m)
    | summarize count()
  " \
  --evaluation-frequency "5m" \
  --window-size "15m" \
  --severity 2 \
  --action-groups "$ACTION_GROUP_ID" \
  --description "Managed identity failed to authenticate to IoT Hub"
```

### Alert 4: Device certificate expired and attempting connection

```bash
az monitor scheduled-query create \
  --name "iot-expired-cert-connection" \
  --resource-group "$RG" \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count > 0" \
  --condition-query "
    AzureDiagnostics
    | where ResourceProvider == 'MICROSOFT.DEVICES'
    | where Category == 'Connections'
    | where authType_s == 'x509'
    | where statusCode_s == '401'
    | where TimeGenerated > ago(1h)
    | summarize FailedDevices = dcount(deviceId_s)
  " \
  --evaluation-frequency "1h" \
  --window-size "1h" \
  --severity 2 \
  --action-groups "$ACTION_GROUP_ID" \
  --description "Devices with expired certificates attempting to connect"
```

---

## Post-migration monitoring checklist

- [ ] Diagnostic settings enabled on IoT Hub (all categories)
- [ ] Entra diagnostic settings enabled (ManagedIdentitySignInLogs)
- [ ] Key Vault diagnostic settings enabled (AuditEvent)
- [ ] Alert: Authentication failure spike (> 50 in 15 min)
- [ ] Alert: SAS authentication detected post-migration
- [ ] Alert: Managed identity auth failure
- [ ] Alert: Expired certificate connection attempts
- [ ] Alert: Certificates expiring within 30 days
- [ ] Dashboard: Migration progress (auth type over time)
- [ ] Dashboard: Current auth distribution
- [ ] Dashboard: Service identity usage
- [ ] Dashboard: Certificate health
- [ ] Weekly review of unused RBAC assignments
- [ ] Monthly review of certificate renewal compliance

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Best Practices](best-practices.md) | [Managed Identity Migration](managed-identity-migration.md) | [X.509 Migration](x509-migration.md)
