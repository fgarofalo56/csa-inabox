// Event Hubs Namespace - Government Deployment Module
// Streaming ingestion for real-time analytics

@description('Event Hub namespace name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@allowed(['Basic', 'Standard', 'Premium'])
@description('Pricing tier.')
param sku string = 'Standard'

@description('Throughput units.')
param capacity int = 1

@description('Enable auto-inflate.')
param autoInflateEnabled bool = true

@description('Maximum throughput units for auto-inflate.')
param maximumThroughputUnits int = 4

@description('Enable Kafka protocol.')
param kafkaEnabled bool = true

@description('Enable zone redundancy.')
param zoneRedundant bool = false

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

// #checkov:skip=CKV_AZURE_224:Event Hubs CMK configured out-of-band for gov deployments
resource eventHubNamespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
    tier: sku
    capacity: capacity
  }
  properties: {
    isAutoInflateEnabled: autoInflateEnabled
    maximumThroughputUnits: autoInflateEnabled ? maximumThroughputUnits : 0
    kafkaEnabled: kafkaEnabled
    zoneRedundant: zoneRedundant
    publicNetworkAccess: 'Disabled'
    minimumTlsVersion: '1.2'
    disableLocalAuth: true  // Force Entra ID auth
  }
}

// Default event hubs for CSA-in-a-Box streaming
resource ehRawEvents 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubNamespace
  name: 'raw-events'
  properties: {
    messageRetentionInDays: 7
    partitionCount: 4
    status: 'Active'
  }
}

resource ehProcessedEvents 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubNamespace
  name: 'processed-events'
  properties: {
    messageRetentionInDays: 3
    partitionCount: 4
    status: 'Active'
  }
}

resource ehAlerts 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: eventHubNamespace
  name: 'alerts'
  properties: {
    messageRetentionInDays: 7
    partitionCount: 2
    status: 'Active'
  }
}

// Consumer groups for each event hub
resource cgADX 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: ehRawEvents
  name: 'adx-ingestion'
  properties: {}
}

resource cgStreaming 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: ehRawEvents
  name: 'stream-analytics'
  properties: {}
}

resource cgCapture 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: ehRawEvents
  name: 'adls-capture'
  properties: {}
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: eventHubNamespace
  properties: {
    workspaceId: logAnalyticsId
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

output namespaceId string = eventHubNamespace.id
output namespaceName string = eventHubNamespace.name
output rawEventsHubName string = ehRawEvents.name
output processedEventsHubName string = ehProcessedEvents.name
output alertsHubName string = ehAlerts.name
