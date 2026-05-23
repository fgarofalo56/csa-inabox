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

// Mirroring CDC consumer group (Spark Structured Streaming reads here)
resource cdcConsumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-05-01-preview' = {
  name: '${ns.name}/$default/csa-loom-mirroring-replicator'
  properties: {
    userMetadata: 'CSA Loom Mirroring Engine — Spark Structured Streaming consumer'
  }
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

output namespaceId string = ns.id
output namespaceName string = ns.name
output namespaceFqdn string = '${ns.name}.servicebus.windows.net'
