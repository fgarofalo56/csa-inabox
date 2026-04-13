// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create an Event Hub namespace for DMLZ governance and audit events.
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

@description('Enable Kafka protocol support.')
param kafkaEnabled bool = true

@description('Event hubs to create. Array of objects: { name, partitionCount, messageRetentionInDays }')
param eventHubs array = [
  { name: 'governance-events', partitionCount: 4, messageRetentionInDays: 7 }
  { name: 'audit-logs', partitionCount: 4, messageRetentionInDays: 7 }
  { name: 'purview-events', partitionCount: 2, messageRetentionInDays: 7 }
  { name: 'policy-events', partitionCount: 2, messageRetentionInDays: 7 }
]

@description('Name of the default consumer group created on each event hub for governance processing.')
param defaultConsumerGroupName string = 'governance-processor'

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

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

@description('Enable Customer-Managed Key (CMK) encryption.')
param parEnableCmk bool = false

@description('Key Vault URI (e.g. https://myvault.vault.azure.net) when CMK is enabled.')
param parCmkKeyVaultUri string = ''

@description('Key name in the Key Vault for CMK encryption.')
param parCmkKeyName string = ''

@description('Key version. Leave empty for automatic key rotation (recommended).')
param parCmkKeyVersion string = ''

@description('Resource ID of the user-assigned managed identity for CMK.')
param parCmkIdentityId string = ''

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
    type: parEnableCmk ? 'SystemAssigned,UserAssigned' : 'SystemAssigned'
    userAssignedIdentities: parEnableCmk ? {
      '${parCmkIdentityId}': {}
    } : null
  }
  properties: {
    isAutoInflateEnabled: sku == 'Standard' ? isAutoInflateEnabled : false
    maximumThroughputUnits: sku == 'Standard' && isAutoInflateEnabled ? maximumThroughputUnits : 0
    publicNetworkAccess: publicNetworkAccess
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    kafkaEnabled: sku != 'Basic' ? kafkaEnabled : false
    encryption: parEnableCmk ? {
      keySource: 'Microsoft.KeyVault'
      keyVaultProperties: [
        {
          keyName: parCmkKeyName
          keyVaultUri: parCmkKeyVaultUri
          keyVersion: !empty(parCmkKeyVersion) ? parCmkKeyVersion : null
          identity: {
            userAssignedIdentity: parCmkIdentityId
          }
        }
      ]
    } : null
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

// Consumer Groups — one governance consumer group per event hub, matching
// the DLZ pattern of index-correlated parent references.
resource consumerGroup 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = [
  for (eh, index) in eventHubs: {
    parent: eventHub[index]
    name: defaultConsumerGroupName
    properties: {
      userMetadata: 'DMLZ governance consumer group for ${eh.name}'
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

// Diagnostic Settings — capture governance and audit event streaming logs.
resource eventHubDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${namespaceName}-diagnostics'
  scope: eventHubNamespace
  properties: {
    workspaceId: logAnalyticsWorkspaceId
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

// Resource lock — protects the governance Event Hubs namespace from accidental deletion.
resource eventHubLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: eventHubNamespace
  name: '${namespaceName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ Event Hubs namespace for governance events. Delete via the rollback workflow in docs/ROLLBACK.md.'
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
