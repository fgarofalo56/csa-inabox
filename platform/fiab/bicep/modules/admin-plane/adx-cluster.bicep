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
// clusterPrincipalId is the cluster's system-assigned MI object id. ADX
// EventHub/IoT Hub data connections (KQL Database → Add data connection) require
// this MI to read the SOURCE's shared-access keys. For an Event Hub that's
// "Azure Event Hubs Data Receiver" on the namespace; for an IoT Hub that's
// "IoT Hub Contributor" (role ID 4763167e-fb37-48bb-8710-0fcd9d82e439, grants
// Microsoft.Devices/IotHubs/IotHubKeys/read) on the hub. Those grants are made
// at the SOURCE scope, not here, and the IoT Hub is user-selected at runtime —
// so they are operator-manual one-time actions surfaced as honest-gate
// MessageBars in the editor (see app/api/items/kql-database/[id]/data-connections).
output clusterPrincipalId string = adxCluster.identity.principalId
