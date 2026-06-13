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

@description('Cluster name (admin-plane shared). ADX cluster names are GLOBALLY-unique DNS names, so the default is suffixed with a per-subscription uniqueString — this lets a new tenant/DMLZ estate coexist with an older hub (e.g. during a clean-rebuild migration) without colliding on `adx-csa-loom-shared`. The DLZ landing-zone module derives the same per-sub name in its `adminPlaneAdxClusterName` default (single-sub/tenant paths share the subscription); cross-sub consumers (dlz-attach, multi-sub fan-out) must instead receive the real deployed name via the hub output / LOOM_ADMIN_ADX_CLUSTER.')
param clusterName string = 'adx-csa-loom-${take(uniqueString(subscription().id), 6)}'

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

@description('Console UAMI principal ID — granted Monitoring Contributor at cluster scope (metric alert rules + diagnostic settings) AND AllDatabasesAdmin via principalAssignment (so kusto-client can query / run mgmt commands / ingest across every per-domain database). Empty skips both grants.')
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
    // enablePurge: required for `.purge table records` (GDPR / right-to-be-
    // forgotten erasure). The .purge command targets the Data Management
    // endpoint (ingest-<cluster>.<region>.kusto.windows.net), not the data
    // endpoint, and requires Database Admin on the target database. The Console
    // UAMI holds AllDatabasesAdmin (granted via az kusto
    // cluster-principal-assignment create; see docs/fiab/v3-tenant-bootstrap.md).
    // Exposed as a param (default true) so callers can override per environment.
    enablePurge: enablePurge
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

// ---- Console UAMI → Azure Kusto Contributor at cluster scope ----
// Required for the Admin → Capacity & compute "Scale & manage" detail pane to
// PATCH the cluster SKU (kusto-arm-client.ts updateKustoClusterSku). Monitoring
// Contributor alone cannot change the SKU — ARM returns 403 — so the scale
// drawer would surface an honest-gate MessageBar without this grant.
//
// Azure Kusto Contributor ALSO covers the full cluster lifecycle exposed by the
// KQL-database editor's "Cluster lifecycle & scale" dialog
// (kusto-arm-client.ts stopKustoCluster / startKustoCluster / deleteKustoCluster
// + updateKustoClusterAutoscale / updateKustoStreamingIngest): it includes
// Microsoft.Kusto/clusters/{stop,start}/action, write (PATCH), and delete. No
// extra role assignment is needed for stop/start/delete.
//
// Database & table RBAC (the "Manage principals" dialog) is handled separately
// by ADX data-plane control commands (.add/.drop database|table principal),
// which require the Console UAMI's AllDatabasesAdmin grant below
// (adxConsoleAdmin) — NOT an Azure roleAssignment. Row-Level Security
// (.alter table policy row_level_security) likewise rides AllDatabasesAdmin.
// Role ID 833127c3-3d62-4978-9c27-c0a5e418f64f is cloud-agnostic.
resource consoleKustoContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: adxCluster
  name: guid(adxCluster.id, consolePrincipalId, '833127c3-3d62-4978-9c27-c0a5e418f64f')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '833127c3-3d62-4978-9c27-c0a5e418f64f')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
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

// ARM resource id of the cluster — used by workspace-monitor.bicep to set the
// EventHub data connection's managedIdentityResourceId to the cluster's MI.
output clusterResourceId string = adxCluster.id
