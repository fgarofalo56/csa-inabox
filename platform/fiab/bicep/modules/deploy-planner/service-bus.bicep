// CSA Loom deploy-planner — Azure Service Bus namespace
//
// Wired by the deploy-planner catalog (key: serviceBus → serviceBusEnabled).
// Self-contained: a Standard namespace (queues + topics) with SAS auth
// disabled (Entra-only) plus a starter queue and topic so the Service Bus
// navigator has entities to list. The Loom Console UAMI is granted Azure
// Service Bus Data Owner + Contributor.
//
// Grounded in Microsoft Learn:
//   Microsoft.ServiceBus/namespaces  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.servicebus/namespaces

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Namespace SKU. Standard supports queues + topics/subscriptions.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Standard'

@description('Loom Console UAMI principal ID — granted Azure Service Bus Data Owner (data plane) + Contributor (ARM CRUD). Empty skips the grants.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var nsName = take('sb-loom-${uniqueString(resourceGroup().id)}', 50)

resource ns 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: nsName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: skuName
  }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

// Starter queue so the navigator has an entity to list.
resource queue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: ns
  name: 'loom-queue'
  properties: {
    maxDeliveryCount: 10
    lockDuration: 'PT1M'
  }
}

// Starter topic so the navigator has an entity to list.
resource topic 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' = {
  parent: ns
  name: 'loom-topic'
  properties: {}
}

// Azure Service Bus Data Owner — data plane (role 090c5cfd-751d-490a-894a-3ce6f1109419).
resource sbDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, '090c5cfd-751d-490a-894a-3ce6f1109419')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Contributor — ARM CRUD of queues, topics, subscriptions
// (role b24988ac-6180-42a0-ab88-20f7382dd24c).
resource sbContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output namespaceId string = ns.id
output namespaceName string = ns.name
output namespaceFqdn string = '${ns.name}.servicebus.windows.net'
