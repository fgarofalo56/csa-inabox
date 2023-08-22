// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

targetScope = 'resourceGroup'

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
param purviewAcctName string = 'purviewacct'

@description('SKU of the Purview Account')
param sku object = {
  name: 'Standard'
  capacity: 1
}

@description('Tags of the Purview Account')
param tags object = {
  Owner: 'Data Management and Analytics'
  CloudSacle: 'DMLZ'
  Domain: 'Data Management'
  Contact: 'frgarofa'
  Project: 'Data Management and Analytics'
  Environment: env
  Toolkit: 'bicep'
  Name: purviewAcctName
  costCenter: '12345'
}

@description('Configure Kafka')
@allowed([
    true
    false
  ]
)
param configKafka bool = false

@description('Allow Public Network Access')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('VNet and Subnet info for Private Endpoints')
param endpointConfigs array = [
  {
    vNetRG: 'demo-core-vnet'
    vNetName: 'demo-privatelink-vnet'
    subnet: 'default'
    privateEPGroup: 'portal'
    privateDNSZoneRG: 'demo-core-vnet'
    privateDNSZone: 'privatelink.purviewstudio.azure.com'
  }
  {
    vNetRG: 'demo-core-vnet'
    vNetName: 'demo-privatelink-vnet'
    subnet: 'default'
    privateEPGroup: 'account'
    privateDNSZoneRG: 'demo-core-vnet'
    privateDNSZone: 'privatelink.purview.azure.com'
  }
]

// Resources

resource purviewAcct 'Microsoft.Purview/accounts@2021-12-01' = {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${env}'
  tags: tags
  location: location
  sku: sku
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess
    managedResourceGroupName: 'puurview-${purviewAcctName}-managed-${env}-rg'
    managedResourcesPublicNetworkAccess: 'Disabled'
    managedEventHubState: 'Enabled'
  }

  resource kafkaConfig 'kafkaConfigurations' = if (configKafka) {
    name: 'default'
    properties: {
      consumerGroup: 'purview'
      credentials: {
        identityId: purviewAcct.identity.principalId
        type: 'SystemAssigned'
      }
      eventHubResourceId: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.EventHub/namespaces/${purviewAcct.properties.managedResourceGroupName}/eventhubs/${purviewAcct.properties.name}'
      eventHubType: 'Notification'
      eventStreamingState: 'Enabled'
      eventStreamingType: 'Azure'
    }
  }
}

resource purviewPrivateEndPoint 'Microsoft.Network/privateEndpoints@2023-04-01' = [for (config, i) in endpointConfigs: if (publicNetworkAccess == 'Disabled') {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${config.privateEPGroup}-pep-${env}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${config.vNetRG}/providers/Microsoft.Network/virtualNetworks/${config.vNetName}/subnets/${config.subnet}'
    }
    privateLinkServiceConnections: [
      {
        name: 'purviewAcctPortal'
        properties: {
          privateLinkServiceId: purviewAcct.id
          groupIds: [
            '${config.privateEPGroup}'
          ]
        }
      }
    ]
  }
}]


resource pepConfig 'Microsoft.Purview/accounts/privateEndpointConnections@2021-12-01' =  [for (config, i) in endpointConfigs: if (publicNetworkAccess == 'Disabled') {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${config.privateEPGroup}-pep-${env}'
  parent: purviewAcct
  dependsOn:[
    purviewPrivateEndPoint
  ]
  properties: {
    privateEndpoint: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${config.privateEPGroup}/providers/Microsoft.Network/privateEndpoints/${purviewPrivateEndPoint[0]}'
    }
    privateLinkServiceConnectionState: {
      status: 'Approved'
      description: 'DMLZ PEP Approved'
    }
  }
}]

resource purviewPrivateEndpointPortalARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [for (config, i) in endpointConfigs: if (publicNetworkAccess == 'Disabled')  {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${config.privateEPGroup}-pep-${env}/zone'
  dependsOn:[
    pepConfig
  ]
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${pepConfig[0].name}-arecord'
        properties: {
          privateDnsZoneId: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${config.privateDNSZoneRG}/providers/Microsoft.Network/privateDnsZones${config.privateDNSZone}'
        }
      }
    ]
  }
}]
