// CSA Loom DLZ — ADX database (inner module)
// Runs at the ADX cluster's resource group scope to satisfy Bicep
// BCP165 (a child resource's scope must match its parent's).

targetScope = 'resourceGroup'

@description('ADX cluster name (in this RG)')
param adxClusterName string

@description('ADX cluster location (must match cluster)')
param adxClusterLocation string

@description('Database name')
param dbName string

@description('Soft delete period (days)')
param softDeletePeriodDays int

@description('Hot cache period (days)')
param hotCachePeriodDays int

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Activator UAMI principal ID (optional Viewer role)')
param activatorPrincipalId string = ''

resource adxCluster 'Microsoft.Kusto/clusters@2024-04-13' existing = {
  name: adxClusterName
}

resource adxDb 'Microsoft.Kusto/clusters/databases@2024-04-13' = {
  parent: adxCluster
  name: dbName
  location: adxClusterLocation
  kind: 'ReadWrite'
  properties: {
    softDeletePeriod: 'P${softDeletePeriodDays}D'
    hotCachePeriod: 'P${hotCachePeriodDays}D'
  }
}

// NOTE: Runtime database role grants (the Loom console RBAC panel →
// /api/adx/roles → `.add` / `.drop database <db> <role> ('<fqn>')`) are
// data-plane Kusto control commands, NOT ARM resources, so they do not need a
// Bicep resource here. The two principalAssignments below are the only STATIC,
// ARM-plane grants: the admin Entra group (Database Admin, so the console UAMI
// inheriting AllDatabasesAdmin can run the runtime `.add/.drop` commands) and
// the optional Activator app (Viewer). Per-table row-level-security
// (`.alter table … policy row_level_security`) and external tables
// (`.create-or-alter external table … kind=delta|storage`) are likewise
// data-plane commands authored at runtime, not ARM resources.
resource adxDbAdmin 'Microsoft.Kusto/clusters/databases/principalAssignments@2024-04-13' = {
  parent: adxDb
  name: 'admins-group'
  properties: {
    principalId: adminEntraGroupId
    principalType: 'Group'
    role: 'Admin'
    tenantId: subscription().tenantId
  }
}

resource adxDbActivatorViewer 'Microsoft.Kusto/clusters/databases/principalAssignments@2024-04-13' = if (!empty(activatorPrincipalId)) {
  parent: adxDb
  name: 'activator-viewer'
  properties: {
    principalId: activatorPrincipalId
    principalType: 'App'
    role: 'Viewer'
    tenantId: subscription().tenantId
  }
}

output databaseId string = adxDb.id
output databaseName string = adxDb.name
output databaseUri string = '${adxCluster.properties.uri}/${dbName}'
