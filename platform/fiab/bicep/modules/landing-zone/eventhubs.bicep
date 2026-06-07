// CSA Loom DLZ — Event Hubs namespace (Kafka protocol surface)
// Used by Mirroring Engine for Debezium CDC transport.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name')
param domainName string

@description('Throughput units (1-40 for Standard; auto-inflate enabled)')
@minValue(1)
@maxValue(40)
param throughputUnits int = 2

@description('Kafka enabled')
param kafkaEnabled bool = true

@description('Auto-inflate enabled')
param autoInflate bool = true

@description('Max throughput units when auto-inflating')
@minValue(1)
@maxValue(40)
param maxThroughputUnits int = 20

@description('Private endpoint subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for Service Bus / Event Hubs')
param privateDnsZoneServicebusId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Loom Console UAMI principal ID — granted Azure Event Hubs Data Owner (data plane) + Contributor (ARM control plane) on the namespace so the Eventstream editor\'s Event Hubs navigator can create/list/delete hubs, consumer groups, and schema groups. Empty skips the grants.')
param consolePrincipalId string = ''

@description('ADF system-assigned MI principal ID — granted Azure Event Hubs Data Sender so ADF CDC pipelines (Eventstream "CDC" source nodes) can write decoded change events to namespace Event Hubs. Empty skips the grant.')
param adfPrincipalId string = ''

@description('Disable local (SAS key) authentication on the namespace. Defaults true (Entra-only — the secure default and the only allowed posture at IL5/GCC-High). Set false ONLY in Commercial deployments where a custom-app Eventstream source must push events with a SAS connection string; Entra/HTTPS-REST ingest works regardless.')
param disableLocalAuth bool = true

@description('ADX cluster system-assigned MI principal ID (from admin-plane adx-cluster.bicep output clusterPrincipalId). When set, granted Azure Event Hubs Data Receiver on the namespace so a KQL-database Event Hub data connection can read events without SAS. REQUIRED before PUT .../dataConnections succeeds (the portal auto-grants this; the ARM REST API does not). Empty skips the grant.')
param adxClusterPrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

resource ns 'Microsoft.EventHub/namespaces@2024-05-01-preview' = {
  name: 'evhns-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  sku: {
    name: 'Standard'
    tier: 'Standard'
    capacity: throughputUnits
  }
  properties: {
    isAutoInflateEnabled: autoInflate
    maximumThroughputUnits: maxThroughputUnits
    kafkaEnabled: kafkaEnabled
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: disableLocalAuth
    minimumTlsVersion: '1.2'
    zoneRedundant: true
  }
}

// Per-mirror Event Hubs (event hub + consumer group) are created at
// mirror-registration time, not at namespace deploy time. The
// Mirroring Engine setup wizard creates them via the Kafka Connect
// REST API when a new mirror config is registered. See
// docs/fiab/services/mirroring-engine.md for the registration flow.

// ---------------------------------------------------------------------
// Default telemetry hub — backs the Event Hubs Data Explorer "receive"
// path (real AMQP receive). Provisioned at deploy time (not per-mirror)
// so the Eventstream / Data Explorer surface has a hub to read from on a
// fresh deploy. Mirrors the live Commercial deployment one-for-one:
//   hub            : loom-telemetry  (2 partitions, 24h / 1-day retention)
//   consumer group : loom-receiver
//   UAMI grant     : Azure Event Hubs Data Receiver (namespace scope)
// ---------------------------------------------------------------------
@description('Telemetry event hub name (Data Explorer receive path). Live: loom-telemetry.')
param telemetryHubName string = 'loom-telemetry'

@description('Telemetry event hub partition count.')
@minValue(1)
@maxValue(32)
param telemetryHubPartitionCount int = 2

@description('Telemetry event hub message retention in days.')
@minValue(1)
@maxValue(7)
param telemetryHubRetentionDays int = 1

@description('Telemetry consumer group name. Live: loom-receiver.')
param telemetryConsumerGroupName string = 'loom-receiver'

resource telemetryHub 'Microsoft.EventHub/namespaces/eventhubs@2024-05-01-preview' = {
  parent: ns
  name: telemetryHubName
  properties: {
    partitionCount: telemetryHubPartitionCount
    messageRetentionInDays: telemetryHubRetentionDays
  }
}

resource telemetryConsumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-05-01-preview' = {
  parent: telemetryHub
  name: telemetryConsumerGroupName
}

// Private endpoint
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${ns.name}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'evhns-link'
        properties: {
          privateLinkServiceId: ns.id
          groupIds: ['namespace']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'sb-zone', properties: { privateDnsZoneId: privateDnsZoneServicebusId } }
    ]
  }
}

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: ns
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'ArchiveLogs', enabled: true }
      { category: 'OperationalLogs', enabled: true }
      { category: 'AutoScaleLogs', enabled: true }
      { category: 'KafkaCoordinatorLogs', enabled: true }
      { category: 'KafkaUserErrorLogs', enabled: true }
      { category: 'EventHubVNetConnectionEvent', enabled: true }
      { category: 'CustomerManagedKeyUserLogs', enabled: true }
      { category: 'RuntimeAuditLogs', enabled: true }
      { category: 'ApplicationMetricsLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Console UAMI grants so the Event Hubs navigator can manage entities.
// Azure Event Hubs Data Owner — data plane (send/receive + entity ownership).
resource ehDataOwnerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, 'f526a384-b230-433a-b45c-95f59c4a2dec')
  properties: {
    // Azure Event Hubs Data Owner
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f526a384-b230-433a-b45c-95f59c4a2dec')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Contributor (namespace scope only) — ARM control-plane CRUD of event hubs,
// consumer groups, schema groups, and authorization rules.
resource ehContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    // Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Azure Event Hubs Data Receiver — data-plane receive on the namespace so
// the Data Explorer "receive" path (loom-telemetry / loom-receiver) can read
// events via AMQP with the Console UAMI.
resource ehDataReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, consolePrincipalId, 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
  properties: {
    // Azure Event Hubs Data Receiver
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Azure Event Hubs Data Sender — granted to the ADF factory MI so Eventstream
// "CDC" source pipelines (database change feed → Event Hub) can write decoded
// change events to the namespace's hubs with the factory's managed identity.
resource ehAdfDataSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adfPrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, adfPrincipalId, '2b629674-e913-4c01-ae53-ef4638d8f975')
  properties: {
    // Azure Event Hubs Data Sender
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2b629674-e913-4c01-ae53-ef4638d8f975')
    principalId: adfPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Azure Event Hubs Data Receiver for the ADX cluster's system-assigned MI.
// ADX uses this identity (managedIdentityResourceId = the cluster ARM id) to
// pull events when a KQL-database Event Hub data connection is created. The
// PUT .../dataConnections call FAILS until this grant exists — the Azure
// portal auto-grants it, but the ARM REST API (what the Loom wizard calls)
// does not, so we pre-grant here. Role GUID a638d3c7-... = Azure Event Hubs
// Data Receiver.
resource adxEhDataReceiverRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adxClusterPrincipalId) && !skipRoleGrants) {
  scope: ns
  name: guid(ns.id, adxClusterPrincipalId, 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
  properties: {
    // Azure Event Hubs Data Receiver
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
    principalId: adxClusterPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output namespaceId string = ns.id
output namespaceName string = ns.name
// Sovereign-cloud Service Bus suffix, derived from the storage suffix the same
// way main.bicep derives the Cosmos suffix (Commercial/GCC servicebus.windows.net;
// GCC-High/IL5 servicebus.usgovcloudapi.net) so the FQDN is correct per cloud.
output namespaceFqdn string = '${ns.name}.servicebus.${environment().suffixes.storage == 'core.usgovcloudapi.net' ? 'usgovcloudapi.net' : 'windows.net'}'
output telemetryHubName string = telemetryHub.name
output telemetryConsumerGroupName string = telemetryConsumerGroup.name
