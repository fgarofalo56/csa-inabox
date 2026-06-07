// CSA Loom — Admin Plane shared ADX cluster (small Dev SKU).
// Per-DLZ databases attach to this single shared cluster (per
// docs/fiab/architecture.md §5.3 — "shared ADX, per-domain DBs").
//
// SKU: Dev(No SLA)_Standard_E2a_v4 — ~$140/mo. Reasonable for the
// federal demo footprint. Upgrade to Standard_E4d_v5 (or higher) for
// production-equivalent throughput.
//
// Follower database attach (database shortcut, T7): the console follower API
// route (app/api/items/kql-database/[id]/follower) creates
// `attachedDatabaseConfigurations` on THIS cluster at runtime via ARM — no
// Bicep resource is needed for the follower side (it is data/runtime, not infra).
// The console UAMI already holds rights on this cluster. To follow a database on
// a LEADER cluster in another RG/subscription, that leader's owner must grant the
// console UAMI 'Contributor' (or 'Azure Kusto Contributor') on the leader cluster,
// out-of-band, e.g.:
//   az role assignment create --role Contributor \
//     --assignee <console-UAMI-principalId> \
//     --scope /subscriptions/<leaderSub>/resourceGroups/<leaderRg>/providers/Microsoft.Kusto/clusters/<leaderName>
// Leader and follower must be in the SAME Azure region (ADX follower constraint).

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

@description('Enable optimized auto-scale on the cluster. Must be false for Dev(No SLA)/Basic-tier SKUs (ARM rejects optimizedAutoscale on Basic tier).')
param enableOptimizedAutoscale bool = false

@description('Optimized auto-scale minimum instance count. Ignored when enableOptimizedAutoscale is false.')
@minValue(2)
@maxValue(1000)
param autoscaleMinimum int = 2

@description('Optimized auto-scale maximum instance count. Ignored when enableOptimizedAutoscale is false.')
@minValue(2)
@maxValue(1000)
param autoscaleMaximum int = 10

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
    // enablePurge: required for `.purge table records` (GDPR / right-to-be-
    // forgotten erasure). The .purge command targets the Data Management
    // endpoint (ingest-<cluster>.<region>.kusto.windows.net), not the data
    // endpoint, and requires Database Admin on the target database. The Console
    // UAMI holds AllDatabasesAdmin (granted via az kusto
    // cluster-principal-assignment create; see docs/fiab/v3-tenant-bootstrap.md).
    enablePurge: true
    enableAutoStop: true
    publicNetworkAccess: 'Enabled'
    // Optimized auto-scale — null when disabled (Dev/Basic SKUs reject it).
    // version is always 1 per the ARM schema. Mirrors the runtime ARM PATCH
    // surfaced in the Eventhouse editor (Manage › Auto-scale).
    optimizedAutoscale: enableOptimizedAutoscale ? {
      isEnabled: true
      minimum: autoscaleMinimum
      maximum: autoscaleMaximum
      version: 1
    } : null
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
