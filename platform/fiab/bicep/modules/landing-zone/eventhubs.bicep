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
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    zoneRedundant: true
  }
}

// Per-mirror Event Hubs (event hub + consumer group) are created at
// mirror-registration time, not at namespace deploy time. The
// Mirroring Engine setup wizard creates them via the Kafka Connect
// REST API when a new mirror config is registered. See
// docs/fiab/services/mirroring-engine.md for the registration flow.

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

output namespaceId string = ns.id
output namespaceName string = ns.name
output namespaceFqdn string = '${ns.name}.servicebus.windows.net'
