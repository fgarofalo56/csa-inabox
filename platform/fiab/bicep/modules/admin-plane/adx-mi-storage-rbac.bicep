// CSA Loom — ADX cluster MI → Storage Blob Data Contributor on the DLZ ADLS account.
//
// The ADLS Gen2 account lives in the DLZ resource group, NOT the admin RG where
// the ADX cluster is created. A role assignment scoped to a resource in another
// RG cannot be authored inline in adx-cluster.bicep (BCP139). It is also illegal
// to use the freshly-created cluster's identity.principalId directly in a role
// assignment name (BCP120, runtime value). Both constraints are solved the same
// way the rest of this repo solves them (see scaling-rbac.bicep): a dedicated
// RG-scoped module, called with scope: resourceGroup(dlzRg), that receives the
// principalId as a plain start-time-known param.
//
// Role: Storage Blob Data Contributor (ba92f5b4-2d11-453d-a403-e96b0029c9fe) —
// required so .create-or-alter continuous-export jobs can write Delta Parquet to
// ADLS via the cluster's managed identity. The built-in role ID is cloud-agnostic
// (identical in Commercial / GCC / GCC-High / IL5).

targetScope = 'resourceGroup'

@description('ADLS Gen2 storage account name in this resource group.')
param storageAccountName string

@description('ADX cluster system-assigned MI principal ID (passed as a param so it is start-time-known for the role-assignment name).')
param principalId string

@description('When true, skip the role grant (re-deploy where RBAC exists or deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageAccountName
}

resource adxMiStorageBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId) && !skipRoleGrants) {
  scope: sa
  name: guid(sa.id, principalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    // Storage Blob Data Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
