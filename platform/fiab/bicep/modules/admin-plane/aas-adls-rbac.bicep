// CSA Loom — Direct Lake shim MI → Storage Blob Data Reader on the DLZ ADLS account.
//
// The Direct Lake shim (apps/fiab-direct-lake-shim, DeltaLogEventHandler →
// DerivePartitionName) reads the Delta _delta_log / Parquet add-file paths to
// derive the affected partition before issuing a TOM partition refresh against
// AAS. It only READS the lake — it never writes — so Storage Blob Data Reader
// is sufficient (least privilege; the ADX export MI is the one that writes).
//
// Like adx-export-rbac.bicep / label-rbac-grants.bicep, the ADLS Gen2 account
// lives in the DLZ resource group, not the admin RG where AAS + the shim UAMI
// are created. A role assignment scoped to a cross-RG resource can't be
// authored inline, so this dedicated RG-scoped module is invoked from
// admin-plane/main.bicep with `scope: resourceGroup(loomDlzRg)` and receives
// the start-time-known principalId as a plain param.
//
// Role: Storage Blob Data Reader (2a2b9908-6ea1-4ae2-8e65-a410df84e7d1). The
// built-in role ID is cloud-agnostic (identical in Commercial / GCC / GCC-High
// / IL5), though AAS itself only deploys on Commercial.

targetScope = 'resourceGroup'

@description('ADLS Gen2 storage account name in this (DLZ) resource group.')
param storageAccountName string

@description('Direct Lake shim UAMI principal (object) ID — passed as a param so it is start-time-known for the role-assignment name.')
param principalId string

@description('When true, skip the role grant (re-deploy where RBAC exists or deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageAccountName
}

resource directLakeStorageBlobDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId) && !skipRoleGrants) {
  scope: sa
  name: guid(sa.id, principalId, '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
  properties: {
    // Storage Blob Data Reader
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
