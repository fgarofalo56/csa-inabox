// CSA Loom DLZ — cross-RG Storage Blob Data Contributor grant (D7 — audit-t165)
//
// Grants a principal (an ADF factory MI, a Stream Analytics job MI, …) the
// "Storage Blob Data Contributor" role on a DLZ ADLS Gen2 account. Deployed as a
// SEPARATE module so the role assignment can target the storage account in the
// DLZ -storage tier RG even when the consumer deploys into a different tier RG
// (ADF → -compute, Stream Analytics → -streaming). Mirrors the cross-RG pattern
// already used by synapse-storage-rbac.bicep. The storage account is resolved by
// name in THIS module's RG, so the caller must scope this module to the RG that
// holds the account (`scope: resourceGroup(<-storage RG>)`).
targetScope = 'resourceGroup'

@description('DLZ ADLS Gen2 storage account name (resides in THIS module RG — the -storage tier RG).')
param storageAccountName string

@description('Principal (service principal / managed identity) object id to grant. Empty = skip.')
param principalId string

@description('Stable seed for the role-assignment GUID (use the consumer resource id so the name is unique + deterministic).')
param assignmentSeed string

@description('Skip the grant (re-provision over an existing assignment, or boundaries where the consumer is absent).')
param skipRoleGrants bool = false

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Storage Blob Data Contributor — ba92f5b4-2d11-453d-a403-e96b0029c9fe
resource blobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(principalId)) {
  scope: sa
  name: guid(assignmentSeed, storageAccountName, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
