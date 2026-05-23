// CSA Loom DLZ — Azure Data Explorer database (on shared cluster)
// Per LD-10: shared ADX cluster lives in Admin Plane; one database
// per DLZ. This module creates only the database, not the cluster.

targetScope = 'resourceGroup'

@description('Domain name')
param domainName string

@description('Existing ADX cluster name in Admin Plane')
param adxClusterName string

@description('Existing ADX cluster RG name')
param adxClusterRgName string

@description('Existing ADX cluster sub ID (defaults to current)')
param adxClusterSubId string = subscription().subscriptionId

@description('Soft delete period (days)')
param softDeletePeriodDays int = 365

@description('Hot cache period (days; controls SSD residency)')
param hotCachePeriodDays int = 31

@description('Admin Entra group object ID for AllDatabasesAdmin')
param adminEntraGroupId string

@description('Compliance tags (note: ADX databases inherit cluster tags)')
param complianceTags object

var dbName = 'loomdb-${domainName}'

// We reference the cluster as an existing resource so we can declare
// a child database resource.
resource adxCluster 'Microsoft.Kusto/clusters@2024-04-13' existing = {
  scope: resourceGroup(adxClusterSubId, adxClusterRgName)
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
  tags: complianceTags
}

// Admin assignment — Database principal
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

// Activator Engine uses Viewer role to query the database (read-only)
@description('Activator Engine UAMI principal ID for Viewer role')
param activatorPrincipalId string = ''

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
