// Event Hubs Module
// Deploys Event Hubs namespace with event hubs, consumer groups, private endpoints, and diagnostics
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Event Hubs namespace.')
param namespaceName string

@description('Azure region for the namespace.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('SKU for the Event Hubs namespace.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Standard'

@description('Throughput units for Standard SKU (1-40).')
@minValue(1)
@maxValue(40)
param capacity int = 1

@description('Enable auto-inflate for Standard SKU.')
param isAutoInflateEnabled bool = true

@description('Maximum throughput units for auto-inflate (0-40).')
@minValue(0)
@maxValue(40)
param maximumThroughputUnits int = 10

@description('Event hubs to create. Array of objects: { name, partitionCount, messageRetentionInDays }')
param eventHubs array = []

@description('Public network access.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID for Event Hubs (privatelink.servicebus.windows.net).')
param privateDnsZoneId string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

// Resources
resource eventHubNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: sku
    tier: sku
    capacity: capacity
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    isAutoInflateEnabled: sku == 'Standard' ? isAutoInflateEnabled : false
    maximumThroughputUnits: sku == 'Standard' && isAutoInflateEnabled ? maximumThroughputUnits : 0
    publicNetworkAccess: publicNetworkAccess
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    kafkaEnabled: sku != 'Basic'
  }
}

// Event Hubs
resource eventHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = [
  for eh in eventHubs: {
    parent: eventHubNamespace
    name: eh.name
    properties: {
      partitionCount: contains(eh, 'partitionCount') ? eh.partitionCount : 4
      messageRetentionInDays: contains(eh, 'messageRetentionInDays') ? eh.messageRetentionInDays : 7
    }
  }
]

// Default consumer groups for each event hub
resource consumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = [
  for (eh, index) in eventHubs: {
    parent: eventHub[index]
    name: 'analytics'
    properties: {
      userMetadata: 'Consumer group for analytics processing'
    }
  }
]

// Private Endpoints
resource eventHubPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${namespaceName}-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${namespaceName}-namespace'
          properties: {
            privateLinkServiceId: eventHubNamespace.id
            groupIds: [
              'namespace'
            ]
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource eventHubPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneId)) {
    parent: eventHubPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${namespaceName}-dns-config'
          properties: {
            privateDnsZoneId: privateDnsZoneId
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource eventHubDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${namespaceName}-diagnostics'
  scope: eventHubNamespace
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'ArchiveLogs'; enabled: true }
      { category: 'OperationalLogs'; enabled: true }
      { category: 'AutoScaleLogs'; enabled: true }
      { category: 'KafkaCoordinatorLogs'; enabled: true }
      { category: 'KafkaUserErrorLogs'; enabled: true }
      { category: 'EventHubVNetConnectionEvent'; enabled: true }
      { category: 'CustomerManagedKeyUserLogs'; enabled: true }
      { category: 'RuntimeAuditLogs'; enabled: true }
      { category: 'ApplicationMetricsLogs'; enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics'; enabled: true }
    ]
  }
}

// Outputs
@description('Resource ID of the Event Hubs namespace.')
output namespaceId string = eventHubNamespace.id

@description('Name of the Event Hubs namespace.')
output namespaceName string = eventHubNamespace.name

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = eventHubNamespace.identity.principalId

@description('Event Hub resource IDs.')
output eventHubIds array = [for (eh, index) in eventHubs: eventHub[index].id]
