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
  {
    vNetRG: 'demo-core-vnet'
    vNetName: 'demo-privatelink-vnet'
    subnet: 'default'
    privateEPGroup: 'blob'
    privateDNSZoneRG: 'demo-core-vnet'
    privateDNSZone: 'privatelink.blob.core.windows.net'
  }
  {
    vNetRG: 'demo-core-vnet'
    vNetName: 'demo-privatelink-vnet'
    subnet: 'default'
    privateEPGroup: 'queue'
    privateDNSZoneRG: 'demo-core-vnet'
    privateDNSZone: 'privatelink.queue.core.windows.com'
  }
  {
    vNetRG: 'demo-core-vnet'
    vNetName: 'demo-privatelink-vnet'
    subnet: 'default'
    privateEPGroup: 'namespace'
    privateDNSZoneRG: 'demo-core-vnet'
    privateDNSZone: 'privatelink.servicebus.windows.com'
  }
]

// A function that checks if a storage account exists

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



resource purviewPrivateEndPoint 'Microsoft.Network/privateEndpoints@2023-04-01' = [for (config, i) in endpointConfigs: if (empty(resourceId('Microsoft.Network/privateEndpoints@2023-04-01', '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${config.privateEPGroup}-pep-${env}')) && publicNetworkAccess == 'Disabled') {
 
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${config.privateEPGroup}-pep-${env}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${config.vNetRG}/providers/Microsoft.Network/virtualNetworks/${config.vNetName}/subnets/${config.subnet}'
    }
    manualPrivateLinkServiceConnections: []
    privateLinkServiceConnections: [
      {
        name: 'purviewPrivateEndpoint${config.privateEPGroup}'
        properties: {
          privateLinkServiceId: '${config.privateEPGroup == 'portal' || config.privateEPGroup =='account' ? purviewAcct.id : config.privateEPGroup == 'blob' || config.privateEPGroup == 'queue'? purviewAcct.properties.managedResources.storageAccount : purviewAcct.properties.managedResources.eventHubNamespace}'
          groupIds: [
            '${config.privateEPGroup}'
          ]
        }
      }
    ]
  }
}]

resource purviewPrivateEndpointPortalARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [for (config, i) in endpointConfigs: if (publicNetworkAccess == 'Disabled')  {
  name: 'default'
  parent: purviewPrivateEndPoint[i]
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${purviewPrivateEndPoint[i].name}-arecord'
        properties: {
          privateDnsZoneId: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${config.privateDNSZoneRG}/providers/Microsoft.Network/privateDnsZones/${config.privateDNSZone}'
        }
      }
    ]
  }
}]

resource pepConfig 'Microsoft.Purview/accounts/privateEndpointConnections@2021-12-01' =  [for (config, i) in endpointConfigs: if (publicNetworkAccess == 'Disabled') {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${config.privateEPGroup}-pep-${env}'
  parent: purviewAcct
  dependsOn: [
    purviewPrivateEndPoint[i]
    purviewPrivateEndpointPortalARecord[i]
  ]
  properties: {
    privateEndpoint: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${config.privateDNSZoneRG}/providers/Microsoft.Network/privateEndpoints/${purviewPrivateEndPoint[i]}'
    }
    privateLinkServiceConnectionState: {
      status: 'Approved'
      description: 'DMLZ PEP Approved'
    }
  }
}]
