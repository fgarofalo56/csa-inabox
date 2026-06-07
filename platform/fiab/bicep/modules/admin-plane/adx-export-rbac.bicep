// Grants the shared ADX cluster's system-assigned managed identity
// "Storage Blob Data Contributor" on the ADLS Gen2 account used as the target
// for Kusto continuous-export (Delta) — i.e. OneLake-style availability,
// Azure-native (no Fabric workspace).
//
// The cluster writes Delta files via impersonation connection strings:
//   h@'abfss://<container>@<account>.dfs.<suffix>/<path>;impersonate'
// which authenticate as the cluster MI. Per Learn, ADLS Gen2 continuous-export
// requires the MI to hold Storage Blob Data Contributor on the account:
//   https://learn.microsoft.com/kusto/management/data-export/continuous-export-with-managed-identity
//   https://learn.microsoft.com/kusto/management/external-tables-delta-lake
//
// Deployed at the storage account's resource group scope (the DLZ lake account
// commonly lives in a different RG than the admin-plane cluster), so the parent
// invokes this module with `scope: resourceGroup(<storageRg>)`.
targetScope = 'resourceGroup'

@description('ADLS Gen2 storage account name to grant the ADX cluster MI Storage Blob Data Contributor on. Backs LOOM_RTI_EXPORT_ADLS.')
param exportAdlsAccountName string

@description('ADX cluster system-assigned MI principal (object) id. Empty = skip the grant.')
param clusterPrincipalId string = ''

// Storage Blob Data Contributor
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: exportAdlsAccountName
}

resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(clusterPrincipalId)) {
  // guid() is deterministic — re-running after the grant exists is a no-op (idempotent).
  name: guid(sa.id, clusterPrincipalId, storageBlobDataContributorRoleId)
  scope: sa
  properties: {
    principalId: clusterPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalType: 'ServicePrincipal'
  }
}
