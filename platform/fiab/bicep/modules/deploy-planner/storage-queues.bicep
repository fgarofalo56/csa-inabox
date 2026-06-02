// CSA Loom deploy-planner — Storage Queues (queue service on a Storage account)
//
// Wired by the deploy-planner catalog (key: storageQueues → storageQueuesEnabled).
// Self-contained: a StorageV2 account with shared-key access disabled
// (Entra-only), one starter queue, and the Loom Console UAMI granted Storage
// Queue Data Contributor so the BFF can enqueue/dequeue token-only.
//
// Grounded in Microsoft Learn:
//   Microsoft.Storage/storageAccounts/queueServices/queues  (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.storage/storageaccounts/queueservices/queues

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Console UAMI principal ID — granted Storage Queue Data Contributor. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('saqloom${uniqueString(resourceGroup().id)}', 24)

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2024-01-01' = {
  parent: sa
  name: 'default'
}

resource queue 'Microsoft.Storage/storageAccounts/queueServices/queues@2024-01-01' = {
  parent: queueService
  name: 'loom-queue'
}

// Storage Queue Data Contributor — data plane token-only
// (role 974c5e8b-45b9-4653-ba55-5f855dd0fb88).
resource queueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: sa
  name: guid(sa.id, consolePrincipalId, '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountId string = sa.id
output storageAccountName string = sa.name
output queueEndpoint string = sa.properties.primaryEndpoints.queue
output queueName string = queue.name
