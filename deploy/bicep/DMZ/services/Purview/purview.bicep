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



resource purviewPrivateEndPoint 'Microsoft.Network/privateEndpoints@2023-04-01' = [for item in endpointConfigs: if (empty(resourceId('Microsoft.Network/privateEndpoints@2023-04-01', '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${item.privateEPGroup}-pep-${env}')) && publicNetworkAccess == 'Disabled') {
 
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${item.privateEPGroup}-pep-${env}'
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
          privateLinkServiceId: '${item.privateEPGroup == 'portal' || item.privateEPGroup =='account' ? purviewAcct.id : item.privateEPGroup == 'blob' || item.privateEPGroup == 'queue'? purviewAcct.properties.managedResources.storageAccount : purviewAcct.properties.managedResources.eventHubNamespace}'
          groupIds: [
            '${item.privateEPGroup}'
          ]
        }
      }
    ]
  }
}]

resource purviewPrivateEndpointPortalARecord 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2020-11-01' = [for item in endpointConfigs: if (empty(resourceId('Microsoft.Network/privateEndpoints@2023-04-01', '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${item.privateEPGroup}-pep-${env}')) && publicNetworkAccess == 'Disabled')  {
  name: 'default'
  parent: purviewPrivateEndPoint[indexOf(endpointConfigs, item)]
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${purviewPrivateEndPoint[indexOf(endpointConfigs, item)].name}-arecord'
        properties: {
          privateDnsZoneId: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${item.privateDNSZoneRG}/providers/Microsoft.Network/privateDnsZones/${item.privateDNSZone}'
        }
      }
    ]
  }
}]

resource pepConfig 'Microsoft.Purview/accounts/privateEndpointConnections@2021-12-01' =  [for item in endpointConfigs: if (publicNetworkAccess == 'Disabled') {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${item.privateEPGroup}-pep-${env}'
  parent: purviewAcct
  dependsOn: [
    purviewPrivateEndPoint[indexOf(endpointConfigs, item)]
    purviewPrivateEndpointPortalARecord[indexOf(endpointConfigs, item)]
  ]
  properties: {
    privateEndpoint: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${item.privateDNSZoneRG}/providers/Microsoft.Network/privateEndpoints/${purviewPrivateEndPoint[indexOf(endpointConfigs, item)]}'
    }
    privateLinkServiceConnectionState: {
      status: 'Approved'
      description: 'DMLZ PEP Approved'
    }
  }
}]
