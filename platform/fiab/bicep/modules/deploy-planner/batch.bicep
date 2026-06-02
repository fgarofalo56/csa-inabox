// CSA Loom deploy-planner — Azure Batch account
//
// Wired by the deploy-planner catalog (key: batch → batchEnabled).
// Self-contained: a backing Storage account (auto-storage, used by Batch for
// application packages + node data) and a Batch account in BatchService pool
// allocation mode with public network access, system-assigned identity, and
// auto-storage authenticated via the Batch account's managed identity (no
// storage keys). The Loom Console UAMI is granted Contributor on the Batch
// account so the navigator can manage pools/jobs over ARM.
//
// Grounded in Microsoft Learn:
//   Microsoft.Batch/batchAccounts (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.batch/batchaccounts

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Console UAMI principal ID — granted Contributor so the BFF can manage Batch pools/jobs. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var suffix = uniqueString(resourceGroup().id)
var saName = take('sabatchloom${suffix}', 24)
var batchName = take('batchloom${suffix}', 24)

// Auto-storage account for the Batch account (application packages + node data).
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource batch 'Microsoft.Batch/batchAccounts@2024-02-01' = {
  name: batchName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    poolAllocationMode: 'BatchService'
    publicNetworkAccess: 'Enabled'
    autoStorage: {
      storageAccountId: sa.id
      // Batch authenticates to auto-storage via its own managed identity,
      // so no storage account keys are minted or stored.
      authenticationMode: 'BatchAccountManagedIdentity'
    }
  }
}

// Storage Blob Data Contributor on the auto-storage account for the Batch
// account's managed identity (role ba92f5b4-2d11-453d-a403-e96b0029c9fe),
// required when autoStorage uses BatchAccountManagedIdentity.
resource batchStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: sa
  name: guid(sa.id, batch.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: batch.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Contributor — ARM management of pools/jobs on the Batch account
// (role b24988ac-6180-42a0-ab88-20f7382dd24c).
resource batchContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: batch
  name: guid(batch.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output batchAccountId string = batch.id
output batchAccountName string = batch.name
output accountEndpoint string = batch.properties.accountEndpoint
