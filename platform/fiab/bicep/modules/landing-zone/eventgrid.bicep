// CSA Loom DLZ — Azure Event Grid custom topic (Microsoft.EventGrid/topics)
//
// Backs the `event-grid-topic` item + eventgrid-topics-client.ts: a navigator over
// the deployment-pinned Event Grid custom topics in the DLZ resource group
// (list / create / read / delete topics, list subscriptions + keys, publish
// CloudEvents). Azure-native, no Microsoft Fabric dependency
// (no-fabric-dependency.md) — Event Grid custom topics are the 1:1 Azure parity for
// Fabric "business events" / Activator structured-signal routing.
//
// NOTE: the existing eventgrid-business.bicep already provisions the always-on
// `loom-business-events` topic (publicNetworkAccess Enabled) for the /business-events
// publishing surface. THIS module is additive: a DEDICATED, PE-locked general-purpose
// custom topic for the event-grid-topic navigator, so a fresh deploy lights up the
// item with a private topic. Both topics live in the same RG and both surface in the
// RG-scoped navigator. Opt out (deployEventGrid=false) when the business topic is
// enough — the navigator still functions against it (LOOM_EVENTGRID_RG/SUB already
// point at the DLZ RG).
//
// Posture (mirrors the sibling adf.bicep / eventhubs.bicep DLZ modules):
//   - publicNetworkAccess: Disabled (private link only)
//   - PE on snet-private-endpoints (groupId 'topic') reached over hub→spoke peering
//   - Private DNS zone group → privatelink.eventgrid.azure.net (decoupled: empty
//     zone id skips only the DNS group, the topic + RBAC still provision)
//   - RBAC: Loom Console UAMI → "EventGrid Data Sender" (data-plane publish) +
//     "EventGrid Contributor" (control-plane CRUD). Both gated behind skipRoleGrants.
//   - Diagnostic settings → standardized Loom LAW

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Dedicated custom topic name for the event-grid-topic navigator. Live default: loom-events (distinct from the business-events topic).')
param topicName string = 'loom-events'

@description('Input schema for the topic. CloudEventSchemaV1_0 (the open, governable standard) is the default.')
@allowed([
  'CloudEventSchemaV1_0'
  'EventGridSchema'
])
param inputSchema string = 'CloudEventSchemaV1_0'

@description('Disable local (SAS key) auth — Entra-only publish (the secure default, required at IL5/GCC-High). Set false ONLY in Commercial deployments that explicitly opt into aeg-sas-key auth via LOOM_EVENTGRID_SAS_AUTH=1.')
param disableLocalAuth bool = true

@description('Loom Console UAMI principal ID — granted EventGrid Data Sender (data-plane publish) + EventGrid Contributor (control-plane CRUD) on the topic so the event-grid-topic navigator can create/list topics and publish governed events. Empty skips the grants.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Spoke private-endpoint subnet ID (snet-private-endpoints).')
param privateEndpointSubnetId string

@description('Private DNS zone resource ID for privatelink.eventgrid.azure.net — must be linked to hub + spoke VNets. Empty = the PE registers but its DNS zone group is skipped (the topic still provisions; DNS resolves once the zone is added).')
param eventGridPrivateDnsZoneId string = ''

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

// =====================================================================
// Event Grid custom topic (private)
// =====================================================================

resource topic 'Microsoft.EventGrid/topics@2024-06-01-preview' = {
  name: topicName
  location: location
  tags: complianceTags
  properties: {
    inputSchema: inputSchema
    disableLocalAuth: disableLocalAuth
    publicNetworkAccess: 'Disabled'
  }
}

// =====================================================================
// Private endpoint
// =====================================================================

resource pe 'Microsoft.Network/privateEndpoints@2024-03-01' = {
  name: 'pe-egt-loom-${topicName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'egt-link'
        properties: {
          privateLinkServiceId: topic.id
          groupIds: [ 'topic' ]
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(eventGridPrivateDnsZoneId)) {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'eg-zone', properties: { privateDnsZoneId: eventGridPrivateDnsZoneId } }
    ]
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

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

// =====================================================================
// RBAC — Loom Console UAMI grants
// =====================================================================

// EventGrid Data Sender (data plane) — publish events to the topic.
// Role GUID d5a91429-5739-47e2-a06b-3470a27159e7.
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
// Role GUID 1e241071-0855-49ea-94dc-649edcd759de.
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
