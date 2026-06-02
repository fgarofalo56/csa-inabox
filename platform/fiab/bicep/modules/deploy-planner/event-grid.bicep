// CSA Loom deploy-planner — Azure Event Grid custom topic
//
// Wired by the deploy-planner catalog (key: eventGrid → eventGridEnabled).
// Self-contained: one custom topic with local (SAS) auth disabled so only
// Entra tokens can publish. The Loom Console UAMI is granted EventGrid Data
// Sender + Contributor so the Event Grid navigator can publish + manage
// subscriptions.
//
// Grounded in Microsoft Learn:
//   Microsoft.EventGrid/topics  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.eventgrid/topics

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Event schema the topic accepts.')
@allowed(['EventGridSchema', 'CloudEventSchemaV1_0', 'CustomEventSchema'])
param inputSchema string = 'CloudEventSchemaV1_0'

@description('Loom Console UAMI principal ID — granted EventGrid Data Sender (publish) + Contributor (manage subscriptions). Empty skips the grants.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var topicName = take('egt-loom-${uniqueString(resourceGroup().id)}', 50)

resource topic 'Microsoft.EventGrid/topics@2025-02-15' = {
  name: topicName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    inputSchema: inputSchema
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

// EventGrid Data Sender — data-plane publish (role d5a91429-5739-47e2-a06b-3470a27159e7).
resource egDataSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: topic
  name: guid(topic.id, consolePrincipalId, 'd5a91429-5739-47e2-a06b-3470a27159e7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'd5a91429-5739-47e2-a06b-3470a27159e7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// EventGrid Contributor — ARM CRUD of topics + event subscriptions
// (role 1e241071-0855-49ea-94dc-649edcd759de).
resource egContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: topic
  name: guid(topic.id, consolePrincipalId, '1e241071-0855-49ea-94dc-649edcd759de')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '1e241071-0855-49ea-94dc-649edcd759de')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output topicId string = topic.id
output topicName string = topic.name
output topicEndpoint string = topic.properties.endpoint
