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

@description('Expose enablePurge as a param so callers can override without editing the module. Default true (required for the GDPR .purge route on RTI databases).')
param enablePurge bool = true

@description('Expose enableStreamingIngest as a param so callers can override. Default true (required for the streaming-ingestion toggle + Event Hubs data connections).')
param enableStreamingIngest bool = true

@description('ADLS Gen2 storage account name — the cluster system-assigned MI is granted Storage Blob Data Contributor so continuous-export jobs can write Delta Parquet. Empty skips the grant.')
param adlsAccountName string = ''

@description('Resource group of the ADLS account (defaults to the cluster RG if empty — override to the DLZ RG).')
param adlsAccountRg string = ''

@description('Event Hubs namespace name — the cluster system-assigned MI is granted Azure Event Hubs Data Receiver so data connections can pull events. Empty skips the grant.')
param ehNamespaceName string = ''

@description('Resource group of the Event Hubs namespace (defaults to the cluster RG if empty — override to the DLZ RG).')
param ehNamespaceRg string = ''

@description('Console UAMI principal ID — granted Monitoring Contributor at cluster scope so the Console BFF can create/manage metric alert rules and configure diagnostic settings on the cluster. Empty skips.')
param consolePrincipalId string = ''

@description('When true, skip all role grants (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

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
    enableStreamingIngest: enableStreamingIngest
    enablePurge: enablePurge
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

// =====================================================================
// RBAC — managed-identity grants required for Real-Time Intelligence.
// All three built-in role IDs are cloud-agnostic (identical across
// Commercial / GCC / GCC-High / IL5). Each grant is conditional and
// skipped when its target name is empty or skipRoleGrants is set, so
// the deploy never fails on a missing dependency — the editor surfaces
// an honest infra-gate instead (per no-vaporware.md).
// =====================================================================

// ---- Cross-RG: cluster MI → Storage Blob Data Contributor on ADLS ----
// Required for .create-or-alter continuous-export jobs to write Delta to
// ADLS Gen2 via the cluster's managed identity. The ADLS account lives in
// the DLZ RG, so the grant is deployed via an RG-scoped module (cross-RG
// role assignments cannot be authored inline — BCP139 — and the cluster MI
// principalId must be laundered through a param — BCP120).
module adxMiStorageRbac 'adx-mi-storage-rbac.bicep' = if (!empty(adlsAccountName) && !skipRoleGrants) {
  name: 'adx-mi-storage-rbac'
  scope: resourceGroup(!empty(adlsAccountRg) ? adlsAccountRg : resourceGroup().name)
  params: {
    storageAccountName: adlsAccountName
    principalId: adxCluster.identity.principalId
    skipRoleGrants: skipRoleGrants
  }
}

// ---- Cross-RG: cluster MI → Azure Event Hubs Data Receiver on namespace ----
// Required for ARM dataConnections (EventHub kind) to pull events using the
// cluster's managed identity. The EH namespace lives in the DLZ RG, so the
// grant is deployed via an RG-scoped module for the same reasons as above.
module adxMiEventHubRbac 'adx-mi-eventhub-rbac.bicep' = if (!empty(ehNamespaceName) && !skipRoleGrants) {
  name: 'adx-mi-eventhub-rbac'
  scope: resourceGroup(!empty(ehNamespaceRg) ? ehNamespaceRg : resourceGroup().name)
  params: {
    ehNamespaceName: ehNamespaceName
    principalId: adxCluster.identity.principalId
    skipRoleGrants: skipRoleGrants
  }
}

// ---- Console UAMI → Monitoring Contributor at cluster scope ----
// Allows the Console BFF to create scheduled-query alert rules and configure
// diagnostic settings on this cluster (RTI overview metrics, Activator-style
// alert rules, monitoring DB).
resource consoleMonitoringContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: adxCluster
  name: guid(adxCluster.id, consolePrincipalId, '749f88d5-cbae-40b8-bcfc-e573ddc772fa')
  properties: {
    // Monitoring Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '749f88d5-cbae-40b8-bcfc-e573ddc772fa')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output clusterId string = adxCluster.id
output clusterName string = adxCluster.name
output clusterUri string = adxCluster.properties.uri
output clusterDataIngestionUri string = adxCluster.properties.dataIngestionUri
output clusterPrincipalId string = adxCluster.identity.principalId
