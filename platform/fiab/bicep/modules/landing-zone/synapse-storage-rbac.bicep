// Grants the Synapse workspace managed identity "Storage Blob Data Contributor"
// on its DEFAULT ADLS Gen2 storage account. Without this, Synapse Spark fails to
// initialize the Hive metastore (HiveExternalCatalog.createDatabase →
// InvalidAbfsRestOperationException) because the workspace MSI cannot write the
// default-database directory under the default filesystem.
//
// Deployed at the storage account's resource group scope (it may differ from the
// workspace RG), so the parent passes the storage RG via a module scope.
targetScope = 'resourceGroup'

@description('Default ADLS Gen2 storage account name backing the Synapse workspace.')
param defaultStorageAccountName string

@description('Synapse workspace system-assigned MI principal (object) id.')
param synapseManagedIdentityPrincipalId string

// Storage Blob Data Contributor
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: defaultStorageAccountName
}

resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(synapseManagedIdentityPrincipalId)) {
  name: guid(sa.id, synapseManagedIdentityPrincipalId, storageBlobDataContributorRoleId)
  scope: sa
  properties: {
    principalId: synapseManagedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalType: 'ServicePrincipal'
  }
}
