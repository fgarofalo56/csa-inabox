// CSA Loom — data-plane/loom-trino-lake-rbac.bicep  (N7e, cross-RG lake grant)
//
// Grants the Trino engine's identity **Storage Blob Data Reader** on the lake
// account the Iceberg connector reads. Split out of `loom-trino-aca.bicep` in
// round 2 of PR #2641 because the grant MUST be deployed at the scope where the
// lake actually lives.
//
// THE BUG THIS FIXES
//   loom-trino-aca.bicep declared `resource lake … existing` with no scope and
//   was invoked from admin-plane/main.bicep with no `scope:`, so both resolved
//   in the ADMIN resource group. Whenever a lake account name IS supplied the
//   account lives in `loomDlzRg`, so the role assignment targeted a storage
//   account that does not exist in the admin RG and the whole deployment failed
//   with ResourceNotFound. It was only dormant because the account name is
//   empty on every shipped (tenant-topology) parameter file — and
//   gov-provision-trino.yml, which reads the REAL account name off the live
//   console, is precisely the caller that would have tripped it.
//
// Every sibling lake grant in this repo already does it this way —
// label-rbac-grants.bicep, azure-connections-rbac.bicep and
// app-resources-rbac.bicep are all invoked with `scope: resourceGroup(loomDlzRg)`.
// This module makes loom-trino match.
//
// READ-ONLY BY CONSTRUCTION. Storage Blob Data Reader carries no write, no
// delete and no role-assignment rights; the federated engine can only read data
// files in place. No keys, no SAS, no connection strings.

targetScope = 'resourceGroup'

@description('Lake (ADLS Gen2 / blob) storage account name in THIS resource group. Empty skips the grant entirely.')
param lakeStorageAccountName string = ''

@description('PRINCIPAL (object) id of the identity Trino runs as — the Console UAMI on a push-button deploy. Empty skips the grant.')
param trinoPrincipalId string = ''

@description('Skip the grant (estate policy assigns it out-of-band, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Storage Blob Data Reader — built-in, cloud-invariant role id.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var grant = !empty(lakeStorageAccountName) && !empty(trinoPrincipalId) && !skipRoleGrants

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (grant) {
  name: empty(lakeStorageAccountName) ? 'placeholderaccount' : lakeStorageAccountName
}

resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grant) {
  // Deterministic per (scope, principal, role): a re-deploy is idempotent and a
  // duplicate grant from another module collapses onto the same assignment.
  name: guid(lake.id, trinoPrincipalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: trinoPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('True when the lake read grant was created.')
output lakeRoleAssigned bool = grant
