// CSA Loom — Databricks Access Connector MI → Storage Blob Data Contributor on
// the lakehouse ADLS Gen2 account.
//
// Required for table maintenance (OPTIMIZE / ANALYZE / write-back) on Unity
// Catalog external Delta tables backed by ADLS Gen2. The Access Connector's
// system-assigned managed identity is the storage credential UC uses for
// external locations; the Databricks SQL Warehouse runs OPTIMIZE as this MI and
// must rewrite compacted Parquet files + update the Delta transaction log
// (_delta_log) back to the same ADLS account. Storage Blob Data Contributor is
// the least-privilege built-in role that allows that read+write.
//
// Mirrors synapse-storage-rbac.bicep (same role id + conditional-grant shape).
// Deployed at the storage account's resource group scope. NO Fabric dependency —
// this is an Azure storage grant, not a Fabric/OneLake one.
targetScope = 'resourceGroup'

@description('Databricks Access Connector system-assigned MI principal (object) id. Empty = skip (e.g. GCC-High / IL5 where Unity Catalog + the access connector are not provisioned).')
param accessConnectorPrincipalId string = ''

@description('Lakehouse ADLS Gen2 storage account name backing the Databricks external tables.')
param storageAccountName string

@description('Skip all role grants (re-deploy over an existing assignment, or boundaries where the connector is absent).')
param skipRoleGrants bool = false

// Storage Blob Data Contributor
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource dbxContributorGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(accessConnectorPrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, accessConnectorPrincipalId, storageBlobDataContributorRoleId)
  scope: sa
  properties: {
    principalId: accessConnectorPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalType: 'ServicePrincipal'
    description: 'Databricks Access Connector MI — OPTIMIZE / ANALYZE / write-back on external Delta tables (statistics + maintenance).'
  }
}
