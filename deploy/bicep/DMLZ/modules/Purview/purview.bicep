// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// targetScope = 'resourceGroup'

// General parameters

@allowed([
  'dev'
  'test'
  'prod'
])
@minLength(2)
@maxLength(10)
@description('Deployment Environment')
param env string = 'dev'

@description('Azure Location is pulled from Resource Group')
param location string = resourceGroup().location

//Resource parameters

@description('Name of the Purview Account')
@maxLength(24)
param purviewAcctName string

@description('SKU of the Purview Account')
param sku object = {
  name: 'Standard'
  capacity: 1
}

@description('Tags of the Purview Account')
param tags object = {
  Owner: 'Data Management and Analytics'
  CloudScale: 'DMLZ'
  Domain: 'Data Management'
  Contact: 'frgarofa'
  Project: 'Data Management and Analytics'
  Environment: env
  Toolkit: 'bicep'
  costCenter: '12345'
}

@description('Configure Kafka')
@allowed([
  true
  false
])
param configKafka bool

@description('Allow Public Network Access')
@allowed([
  'Enabled'
  'Disabled'
])
param parPurviewPublicNetworkAccess string = 'Disabled'

@description('Attach a CanNotDelete resource lock to the Purview account. Default true for production safety.')
param enableResourceLock bool = true

@description('VNet and Subnet info for Private Endpoints')
param endpointConfigs array = []

@description('Tenant Endpoint State')
@allowed([
  'Enabled'
  'Disabled'
  'NotSpecified'
])
param parTenantEndpointState string

// @description('VNet and Subnet info for Private Endpoints')
// param endpointConfigs array = [
//   {
//     vNetRG: 'demo-core-vnet'
//     vNetName: 'demo-privatelink-vnet'
//     subnet: 'default'
//     privateEPGroup: 'portal'
//     privateDNSZoneRG: 'demo-core-vnet'
//     privateDNSZone: 'privatelink.purviewstudio.azure.com'
//   }
//   {
//     vNetRG: 'demo-core-vnet'
//     vNetName: 'demo-privatelink-vnet'
//     subnet: 'default'
//     privateEPGroup: 'account'
//     privateDNSZoneRG: 'demo-core-vnet'
//     privateDNSZone: 'privatelink.purview.azure.com'
//   }
//   {
//     vNetRG: 'demo-core-vnet'
//     vNetName: 'demo-privatelink-vnet'
//     subnet: 'default'
//     privateEPGroup: 'blob'
//     privateDNSZoneRG: 'demo-core-vnet'
//     privateDNSZone: 'privatelink.blob.core.windows.net'
//   }
//   {
//     vNetRG: 'demo-core-vnet'
//     vNetName: 'demo-privatelink-vnet'
//     subnet: 'default'
//     privateEPGroup: 'queue'
//     privateDNSZoneRG: 'demo-core-vnet'
//     privateDNSZone: 'privatelink.queue.core.windows.com'
//   }
//   {
//     vNetRG: 'demo-core-vnet'
//     vNetName: 'demo-privatelink-vnet'
//     subnet: 'default'
//     privateEPGroup: 'namespace'
//     privateDNSZoneRG: 'demo-core-vnet'
//     privateDNSZone: 'privatelink.servicebus.windows.com'
//   }
// ]

// A function that checks if a storage account exists

resource purviewAcct 'Microsoft.Purview/accounts@2024-04-01-preview' = {
  name: purviewAcctName
  tags: tags
  location: location
  sku: sku
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    cloudConnectors: {}
    ingestionStorage: {
      publicNetworkAccess: 'Disabled'
    }
    managedEventHubState: configKafka ? 'Disabled' : 'Enabled'
    managedResourceGroupName: 'managed-rg-${purviewAcctName}'
    managedResourcesPublicNetworkAccess: 'Disabled'
    publicNetworkAccess: parPurviewPublicNetworkAccess
    tenantEndpointState: parTenantEndpointState
  }
  dependsOn: [
    eventHubNamespace
    eventHub
  ]
}

// Resource lock — protects the Purview catalog from accidental deletion.
// Rebuilding a Purview catalog is a multi-day operation (re-scanning all
// sources and re-applying classifications), so the lock is especially
// valuable here.
resource purviewLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: purviewAcct
  name: '${purviewAcctName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ Purview account. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Assign the Purview account the correct roles for the Event Hub (Event Hubs Data Owner )
resource purviewRoleAssignment 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (configKafka) {
  name: guid(uniqueString(resourceGroup().id, 'DataOwner'))
  scope: resourceGroup()
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', 'f526a384-b230-433a-b45c-95f59c4a2dec')
    principalId: purviewAcct.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource purviewRoleAssignment02 'Microsoft.Authorization/roleAssignments@2020-04-01-preview' = if (configKafka) {
  name: guid(uniqueString(resourceGroup().id, 'EventHubSender'))
  scope: resourceGroup()
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', '2b629674-e913-4c01-ae53-ef4638d8f975')
    principalId: purviewAcct.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource eventHubNamespace 'Microsoft.EventHub/namespaces@2024-05-01-preview' = if (configKafka) {
  name: '${purviewAcctName}-kafka'
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
    capacity: 1
  }
  properties: {
    isAutoInflateEnabled: false
    maximumThroughputUnits: 0
  }
}

resource eventHub 'Microsoft.EventHub/namespaces/eventhubs@2024-05-01-preview' = if (configKafka) {
  parent: eventHubNamespace
  name: 'purview-kafka'
  properties: {
    messageRetentionInDays: 7
    partitionCount: 1
  }
}

// Deploy Kafka Configuration for Purview
resource kafkaConfig 'Microsoft.Purview/accounts/kafkaConfigurations@2024-04-01-preview' = if (configKafka) {
  parent: purviewAcct
  name: '${purviewAcctName}-kafka'
  properties: {
    consumerGroup: 'purview'
    credentials: {
      identityId: purviewAcct.identity.principalId
      type: 'SystemAssigned'
    }
    eventHubResourceId: eventHub.id
    eventHubType: 'Notification'
    eventStreamingState: 'Enabled'
    eventStreamingType: 'Azure'
  }
  dependsOn: [
    purviewRoleAssignment
    purviewRoleAssignment02
  ]
}

resource purviewPrivateEndPoint 'Microsoft.Network/privateEndpoints@2023-04-01' = [
  for item in endpointConfigs: if (parPurviewPublicNetworkAccess == 'Disabled') {
    name: '${toLower(purviewAcctName)}-private-endpoint-${env}-${item.privateEPGroup}'
    location: location
    tags: tags
    properties: {
      subnet: {
        id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${item.vNetRG}/providers/Microsoft.Network/virtualNetworks/${item.vNetName}/subnets/${item.subnet}'
      }
      manualPrivateLinkServiceConnections: []
      privateLinkServiceConnections: [
        {
          name: 'purviewPrivateEndpoint${item.privateEPGroup}'
          properties: {
            privateLinkServiceId: '${item.privateEPGroup == 'portal' || item.privateEPGroup == 'account' ? purviewAcct.id : item.privateEPGroup == 'blob' || item.privateEPGroup == 'queue' ? purviewAcct.properties.managedResources.storageAccount : purviewAcct.properties.managedResources.eventHubNamespace}'
            groupIds: [
              '${item.privateEPGroup}'
            ]
          }
        }
      ]
    }
  }
]

resource purviewPrivateEndpointDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [
  for (item, i) in endpointConfigs: if (parPurviewPublicNetworkAccess == 'Disabled' && !empty(item.privateDNSZone)) {
    name: 'default'
    parent: purviewPrivateEndPoint[i]
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${purviewPrivateEndPoint[i].name}-arecord'
          properties: {
            privateDnsZoneId: resourceId(item.privateDNSZoneRG, 'Microsoft.Network/privateDnsZones', item.privateDNSZone)
          }
        }
      ]
    }
  }
]

// Outputs
output purviewAccountId string = purviewAcct.id
output purviewAccountName string = purviewAcct.name
output managedIdentityPrincipalId string = purviewAcct.identity.principalId
