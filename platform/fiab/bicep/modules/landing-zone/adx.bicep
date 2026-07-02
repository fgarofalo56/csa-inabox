// CSA Loom DLZ — Azure Data Explorer database (cross-RG wrapper)
// Per LD-10: shared ADX cluster lives in Admin Plane RG; this module
// targets the Admin Plane RG via a nested module to create the
// database + principal assignments.

targetScope = 'resourceGroup'

@description('Domain name')
param domainName string

@description('Existing ADX cluster name in Admin Plane')
param adxClusterName string

@description('Existing ADX cluster RG name')
param adxClusterRgName string

@description('Existing ADX cluster sub ID (defaults to current)')
param adxClusterSubId string = subscription().subscriptionId

@description('ADX cluster location (must match cluster). Typically same as DLZ location.')
param adxClusterLocation string

@description('Soft delete period (days)')
param softDeletePeriodDays int = 365

@description('Hot cache period (days; controls SSD residency)')
param hotCachePeriodDays int = 31

@description('Admin Entra group object ID for AllDatabasesAdmin')
param adminEntraGroupId string

@description('Activator Engine UAMI principal ID for Viewer role')
param activatorPrincipalId string = ''

@description('Compliance tags (note: ADX databases inherit cluster tags)')
param complianceTags object

// ADX/KQL database names must be valid bare KQL identifiers — hyphens break
// `database('loomdb-x')`-free query/management commands. Sanitize the domain
// (e.g. "real-time" → "real_time") and use an underscore prefix.
var dbName = 'loomdb_${replace(domainName, '-', '_')}'

module inner 'adx-db-inner.bicep' = {
  name: 'adx-db-${domainName}'
  scope: resourceGroup(adxClusterSubId, adxClusterRgName)
  params: {
    adxClusterName: adxClusterName
    adxClusterLocation: adxClusterLocation
    dbName: dbName
    softDeletePeriodDays: softDeletePeriodDays
    hotCachePeriodDays: hotCachePeriodDays
    adminEntraGroupId: adminEntraGroupId
    activatorPrincipalId: activatorPrincipalId
  }
}

@description('Compliance tags are inherited from the cluster; this output is a passthrough for caller convenience')
output appliedTags object = complianceTags

output databaseId string = inner.outputs.databaseId
output databaseName string = inner.outputs.databaseName
output databaseUri string = inner.outputs.databaseUri
