// CSA Loom DLZ — ADX database (inner module)
// Runs at the ADX cluster's resource group scope to satisfy Bicep
// BCP165 (a child resource's scope must match its parent's).

targetScope = 'resourceGroup'

@description('ADX cluster name (in this RG)')
param adxClusterName string

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
  location: adxCluster.location
  kind: 'ReadWrite'
  properties: {
    softDeletePeriod: 'P${softDeletePeriodDays}D'
    hotCachePeriod: 'P${hotCachePeriodDays}D'
  }
}

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
