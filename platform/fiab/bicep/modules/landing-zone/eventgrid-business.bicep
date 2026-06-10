// CSA Loom DLZ — Event Grid custom topic for the Business Events publishing
// surface (/business-events). Azure-native Activator "structured signals":
// governed business events are published here (CloudEvents v1.0) and fan out to
// Event Hubs / Activator alert rules. No Microsoft Fabric required.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Default business-events custom topic name (matches LOOM_EVENTGRID_BUSINESS_TOPIC). Live default: loom-business-events.')
param topicName string = 'loom-business-events'

@description('Input schema for the topic. CloudEventSchemaV1_0 (the open, governable standard) is the Business Events default.')
@allowed([
  'CloudEventSchemaV1_0'
  'EventGridSchema'
])
param inputSchema string = 'CloudEventSchemaV1_0'

@description('Disable local (SAS key) auth — Entra-only publish (the secure default, required at IL5/GCC-High). Set false ONLY in Commercial deployments that explicitly opt into aeg-sas-key auth via LOOM_EVENTGRID_SAS_AUTH=1.')
param disableLocalAuth bool = true

@description('Loom Console UAMI principal ID — granted EventGrid Data Sender (data-plane publish) + EventGrid Contributor (control-plane CRUD) on the topic so the Business Events surface can create/list topics and publish governed events. Empty skips the grants.')
param consolePrincipalId string = ''

@description('Optional Event Hub ARM resource id to wire a built-in event subscription so published business events also land on a durable stream. Empty skips the subscription (the console publishes to Event Hubs directly via the data plane instead).')
param eventHubResourceId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string = ''

@description('Compliance tags')
param complianceTags object

resource topic 'Microsoft.EventGrid/topics@2024-06-01-preview' = {
  name: topicName
  location: location
  tags: complianceTags
  properties: {
    inputSchema: inputSchema
    disableLocalAuth: disableLocalAuth
    publicNetworkAccess: 'Enabled'
  }
}

// Optional fan-out → Event Hub so published business events also land on the
// durable stream and become subscribable in the Real-Time hub.
resource toEventHub 'Microsoft.EventGrid/topics/eventSubscriptions@2024-06-01-preview' = if (!empty(eventHubResourceId)) {
  parent: topic
  name: 'to-eventhub'
  properties: {
    destination: {
      endpointType: 'EventHub'
      properties: {
        resourceId: eventHubResourceId
      }
    }
    eventDeliverySchema: inputSchema == 'EventGridSchema' ? 'EventGridSchema' : 'CloudEventSchemaV1_0'
    retryPolicy: {
      maxDeliveryAttempts: 10
      eventTimeToLiveInMinutes: 1440
    }
  }
}

// Diagnostic settings → standardized Loom LAW (capacity metering source).
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: topic
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'DeliveryFailures', enabled: true }
      { category: 'PublishFailures', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// EventGrid Data Sender (data plane) — publish events to the topic.
// Role GUID d5a91429-5739-47e2-a06b-3470a27159e7 = EventGrid Data Sender.
resource egDataSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: topic
  name: guid(topic.id, consolePrincipalId, 'd5a91429-5739-47e2-a06b-3470a27159e7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'd5a91429-5739-47e2-a06b-3470a27159e7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// EventGrid Contributor (control plane) — create/list/read topics + subscriptions.
// Role GUID 1e241071-0855-49ea-94dc-649edcd759de = EventGrid Contributor.
resource egContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
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
