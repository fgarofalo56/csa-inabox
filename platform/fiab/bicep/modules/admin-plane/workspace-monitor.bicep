// CSA Loom — Workspace-Monitoring ADX database + diagnostic export pipeline.
//
// Azure-native parity for a Microsoft Fabric "workspace monitoring" Eventhouse
// (.claude/rules/no-fabric-dependency.md). Creates a READ-ONLY ADX database on
// the shared Loom cluster that holds the platform's own usage/performance
// telemetry:
//   - Console UAMI         -> Admin   (creates tables, runs the provisioner)
//   - Admin Entra group    -> Viewer  (read-only — operators query, never alter)
//   - [optional] LAW data-export rule streaming AzureDiagnostics /
//     AzureActivity / AzureMetrics / AppRequests to an Event Hub namespace
//   - [optional] ADX Event Hub data connection ingesting am-AzureDiagnostics
//     into the ResourceDiagnostics table (cluster system-assigned MI auth)
//
// Diagnostic settings themselves are wired per-resource at deploy time
// (modules/shared/diagnostic-settings.bicep, name diag-loom-stdz) and the
// console provisioner enables them on any resource missing one — so the LAW
// fills with the telemetry this export streams into ADX.
//
// API versions match adx-cluster.bicep (Microsoft.Kusto/clusters@2024-04-13).
// Grounded in Microsoft Learn:
//   https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export
//   https://learn.microsoft.com/azure/data-explorer/create-event-hubs-connection
//   https://learn.microsoft.com/azure/templates/microsoft.kusto/clusters/databases/principalassignments

targetScope = 'resourceGroup'

@description('Primary region.')
param location string

@description('Shared ADX cluster name (admin-plane). The monitoring DB is created under it.')
param adxClusterName string

@description('Monitoring database name. Underscores only so the kql-dashboard data-source slug round-trips.')
param monitorDbName string = 'loomdb_workspace_monitor'

@description('Hot cache period (days) — how far back queries stay in hot cache.')
@minValue(1)
@maxValue(60)
param hotCacheDays int = 14

@description('Soft-delete / retention period (days).')
@minValue(1)
@maxValue(365)
param softDeleteDays int = 90

@description('Log Analytics workspace name (same RG). Empty skips the data-export rule.')
param lawName string = ''

@description('Console UAMI principal (object) id — granted Admin on the monitoring DB so the provisioner can create + seed tables. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Admin Entra group object id — granted Viewer (read-only) on the monitoring DB. Empty skips the grant.')
param adminEntraGroupId string = ''

@description('Entra tenant id for the principal assignments.')
param tenantId string = tenant().tenantId

@description('Event Hub namespace ARM resource id. Empty -> skip the LAW data-export + ADX data-connection (DB + seeded tables still work).')
param eventHubNamespaceId string = ''

@description('Skip principal-assignment grants — set true when re-provisioning to avoid PrincipalAssignmentExists.')
param skipRoleGrants bool = false

// Existing shared cluster (deployed by adx-cluster.bicep).
resource adxCluster 'Microsoft.Kusto/clusters@2024-04-13' existing = {
  name: adxClusterName
}

// Read-only monitoring database. ReadWrite kind so the Console UAMI Admin can
// create the schema; operators get Viewer (read-only) below.
resource monitorDb 'Microsoft.Kusto/clusters/databases@2024-04-13' = {
  parent: adxCluster
  name: monitorDbName
  location: location
  kind: 'ReadWrite'
  properties: {
    hotCachePeriod: 'P${hotCacheDays}D'
    softDeletePeriod: 'P${softDeleteDays}D'
  }
}

// Console UAMI -> Admin (create + seed tables, run the provisioner).
resource consoleAdmin 'Microsoft.Kusto/clusters/databases/principalAssignments@2024-04-13' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  parent: monitorDb
  name: 'console-admin'
  properties: {
    principalId: consolePrincipalId
    principalType: 'App'
    role: 'Admin'
    tenantId: tenantId
  }
}

// Admin Entra group -> Viewer (read-only). This is the "read-only for operators"
// guarantee: members can query the telemetry but cannot alter the schema.
resource operatorViewer 'Microsoft.Kusto/clusters/databases/principalAssignments@2024-04-13' = if (!empty(adminEntraGroupId) && !skipRoleGrants) {
  parent: monitorDb
  name: 'operator-viewer'
  properties: {
    principalId: adminEntraGroupId
    principalType: 'Group'
    role: 'Viewer'
    tenantId: tenantId
  }
}

// Existing LAW (same RG) — for the data-export rule.
resource law 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = if (!empty(lawName)) {
  name: lawName
}

// LAW data-export rule -> Event Hub namespace. Each exported table lands in an
// Event Hub named am-<TableName>. Conditional on both a LAW and an EH namespace.
resource monitorExport 'Microsoft.OperationalInsights/workspaces/dataExports@2020-08-01' = if (!empty(lawName) && !empty(eventHubNamespaceId)) {
  parent: law
  name: 'loom-monitor-export'
  properties: {
    destination: {
      resourceId: eventHubNamespaceId
    }
    tableNames: [
      'AzureDiagnostics'
      'AzureActivity'
      'AzureMetrics'
      'AppRequests'
    ]
    enable: true
  }
}

// ADX Event Hub data connection: am-AzureDiagnostics -> ResourceDiagnostics.
// Uses the cluster's system-assigned MI; that MI needs Azure Event Hubs Data
// Receiver on the namespace (granted in the EH namespace's module — the
// namespace lives in the DLZ RG, so the grant is wired there, not here).
resource diagDataConn 'Microsoft.Kusto/clusters/databases/dataConnections@2024-04-13' = if (!empty(eventHubNamespaceId)) {
  parent: monitorDb
  name: 'loom-diag-conn'
  location: location
  kind: 'EventHub'
  properties: {
    eventHubResourceId: '${eventHubNamespaceId}/eventhubs/am-AzureDiagnostics'
    consumerGroup: '$Default'
    tableName: 'ResourceDiagnostics'
    dataFormat: 'JSON'
    compression: 'None'
    managedIdentityResourceId: adxCluster.id
  }
  dependsOn: [
    monitorExport
  ]
}

output monitoringDatabaseName string = monitorDb.name
output monitoringDatabaseId string = monitorDb.id
output monitoringDatabaseUri string = '${adxCluster.properties.uri}/${monitorDb.name}'
