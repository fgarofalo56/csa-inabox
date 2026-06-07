// Grants the Synapse workspace managed identity "Storage Blob Data Contributor"
// on its DEFAULT ADLS Gen2 storage account. Without this, Synapse Spark fails to
// initialize the Hive metastore (HiveExternalCatalog.createDatabase →
// InvalidAbfsRestOperationException) because the workspace MSI cannot write the
// default-database directory under the default filesystem.
//
// This grant ALSO covers Delta Lake OPTIMIZE / VACUUM / ZORDER BY maintenance
// jobs (F19) submitted via Livy interactive sessions: the Spark executor nodes
// run as the workspace MSI and must write compacted Parquet files + update the
// Delta transaction log (_delta_log) back to the same ADLS account. VACUUM also
// deletes tombstoned files. Storage Blob Data Contributor is required for all of
// these — no additional role assignment is needed for maintenance.
//
// Deployed at the storage account's resource group scope (it may differ from the
// workspace RG), so the parent passes the storage RG via a module scope.
targetScope = 'resourceGroup'

@description('Default ADLS Gen2 storage account name backing the Synapse workspace.')
param defaultStorageAccountName string

@description('Synapse workspace system-assigned MI principal (object) id.')
param synapseManagedIdentityPrincipalId string

@description('Console UAMI principal (object) id — granted Storage Blob Data Reader so the BFF live Tables catalog scan can list paths + read _delta_log entries without needing write/Contributor. Empty = skip.')
param consolePrincipalId string = ''

@description('Shared ADX cluster system-assigned MI principal (object) id — granted Storage Blob Data Reader so .create external table kind=delta (…;managed_identity=system) over this lakehouse ADLS account can read the delta log + data files (Eventhouse → lakehouse/warehouse Delta endpoint). Empty = skip.')
param adxClusterPrincipalId string = ''

// Storage Blob Data Contributor
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
// Storage Blob Data Reader (read-only data plane — sufficient for the catalog scan)
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

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

// Console UAMI → Storage Blob Data Reader on the lakehouse storage account.
// Powers the live Delta catalog scan in /api/lakehouse/tables (ADLS listing +
// _delta_log read). Read-only by design — catalog discovery never writes.
resource consoleReaderGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId)) {
  name: guid(sa.id, consolePrincipalId, storageBlobDataReaderRoleId)
  scope: sa
  properties: {
    principalId: consolePrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalType: 'ServicePrincipal'
  }
}

// Shared ADX cluster system MI → Storage Blob Data Reader on the lakehouse
// storage account. Required for the Eventhouse → lakehouse/warehouse Delta
// endpoint: .create-or-alter external table kind=delta (…;managed_identity=system)
// + query_acceleration read the _delta_log + Parquet data files as the cluster MI.
// Read-only — external tables never write back. No Fabric/OneLake dependency.
resource adxReaderGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adxClusterPrincipalId)) {
  name: guid(sa.id, adxClusterPrincipalId, storageBlobDataReaderRoleId)
  scope: sa
  properties: {
    principalId: adxClusterPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalType: 'ServicePrincipal'
  }
}
