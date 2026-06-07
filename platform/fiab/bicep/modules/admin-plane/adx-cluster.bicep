// CSA Loom — Admin Plane shared ADX cluster (small Dev SKU).
// Per-DLZ databases attach to this single shared cluster (per
// docs/fiab/architecture.md §5.3 — "shared ADX, per-domain DBs").
//
// SKU: Dev(No SLA)_Standard_E2a_v4 — ~$140/mo. Reasonable for the
// federal demo footprint. Upgrade to Standard_E4d_v5 (or higher) for
// production-equivalent throughput.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cluster name (admin-plane shared)')
param clusterName string = 'adx-csa-loom-shared'

@description('SKU name')
@allowed([
  'Dev(No SLA)_Standard_E2a_v4'
  'Dev(No SLA)_Standard_D11_v2'
  'Standard_E2a_v4'
  'Standard_E4a_v4'
  'Standard_E8a_v4'
  'Standard_E16a_v4'
])
param skuName string = 'Dev(No SLA)_Standard_E2a_v4'

@description('Tier — Basic for Dev SKUs, Standard for the production SKUs.')
@allowed(['Basic', 'Standard'])
param skuTier string = 'Basic'

@description('Capacity (instance count). 1 for Dev SKUs.')
param skuCapacity int = 1

@description('LAW resource id for diagnostic settings.')
param workspaceId string

@description('Compliance tags')
param complianceTags object

@description('Console UAMI principalId — granted AllDatabasesAdmin on the cluster so the KQL navigator and kusto-client can query / run mgmt commands / ingest. Empty skips the grant (e.g. when the cluster principal-assignment is managed out-of-band).')
param consolePrincipalId string = ''

resource adxCluster 'Microsoft.Kusto/clusters@2024-04-13' = {
  name: clusterName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: skuTier
    capacity: skuCapacity
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    enableDiskEncryption: true
    enableDoubleEncryption: false
    enableStreamingIngest: true
    enablePurge: true
    enableAutoStop: true
    publicNetworkAccess: 'Enabled'
  }
}

resource adxDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: adxCluster
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output clusterId string = adxCluster.id
output clusterName string = adxCluster.name
output clusterUri string = adxCluster.properties.uri
output clusterDataIngestionUri string = adxCluster.properties.dataIngestionUri
output clusterPrincipalId string = adxCluster.identity.principalId

// ADX data-plane RBAC. ADX roles (AllDatabasesAdmin/Viewer) are NOT Azure
// RBAC roleDefinitions (no GUID) — they are assigned via the cluster's own
// principalAssignments child resource. Grants the Console UAMI cluster-wide
// admin so kusto-client can query / run .create-merge / ingest across every
// per-domain database. principalType 'App' = service principal (the UAMI).
resource adxConsoleAdmin 'Microsoft.Kusto/clusters/principalAssignments@2024-04-13' = if (!empty(consolePrincipalId)) {
  parent: adxCluster
  name: 'console-uami-alldatabasesadmin'
  properties: {
    principalId: consolePrincipalId
    principalType: 'App'
    role: 'AllDatabasesAdmin'
  }
}
