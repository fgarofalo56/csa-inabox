// CSA Loom — least-privilege lake grant for the S3 gateway (N8 lab 3).
//
// Grants the s3proxy Container App's DEDICATED storage identity (created by
// data-plane/s3-gateway-aca.bicep) **Storage Blob Data Reader** — and nothing
// else — on the ADLS Gen2 account the gateway fronts.
//
// WHY IT IS A SEPARATE MODULE: the lake almost never lives in the admin RG.
//   * single-sub  — the lake is in the DLZ RG (`loomDlzRg`), same subscription.
//   * dlz-attach  — the lake is in a DIFFERENT SUBSCRIPTION entirely (verified
//                   on the live commercial estate: console runs in the DMLZ sub,
//                   `saloomdefault…` lives in the DLZ sub).
// A `resource … existing` declared inside the app module would resolve in the
// APP's resource group and the role assignment would fail with
// ResourceGroupNotFound / ResourceNotFound. This module is therefore invoked
// with an explicit `scope: resourceGroup(<lakeSub>, <lakeRg>)` from the
// orchestrator, which is the only place that knows those coordinates.
//
// Round-1 posture (fixed by this module): the gateway ran as the CONSOLE UAMI,
// which holds Storage Blob Data Contributor on the lake, Key Vault Secrets User,
// Network Contributor on the hub RG and AKS Cluster Admin. `read-only-blobstore`
// is an application-layer control that does not survive a container compromise;
// the IAM boundary does.

targetScope = 'resourceGroup'

@description('ADLS Gen2 account the gateway fronts. MUST exist in THIS module\'s resource group / subscription.')
param storageAccountName string

@description('PRINCIPAL (object) id of the gateway\'s dedicated storage identity — s3-gateway-aca.bicep\'s `storageUamiPrincipalId` output.')
param principalId string

@description('Set false to skip the grant when an estate policy assigns lake roles out-of-band (e.g. a PIM-managed grant process). The gateway then serves 403s until that grant lands — fail-closed, by design.')
param assignRole bool = true

// Storage Blob Data Reader — READ only. Built-in role id is cloud-invariant, so
// the same guid works in Commercial and every Gov boundary.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

var active = assignRole && !empty(storageAccountName) && !empty(principalId)

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (active) {
  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName
}

// Deterministic guid over (scope, principal, role) so a redeploy is idempotent
// and two modules granting the same pair never collide.
resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (active) {
  name: guid(lake.id, principalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

@description('TRUE when the Storage Blob Data Reader grant was actually applied.')
output granted bool = active

@description('Role the gateway identity holds on the lake. READER — never Contributor.')
output roleDefinitionId string = storageBlobDataReaderRoleId
