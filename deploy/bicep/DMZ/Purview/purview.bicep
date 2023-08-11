metadata deaxeiprion = 'Create a Purview Account'

@description('Location is pulled from Resource Group')
param location string = resourceGroup().location

@description('Name of the Purview Account')
@maxLength(24)
param purviewAcctName string = 'purviewacct'

@description('Deployment Environment')
@allowed([
  'dev'
  'test'
  'prod'
])
param env string = 'dev'

@description('SKU of the Purview Account')
param sku object = {
  name: 'Standard'
  capacity: 1
}

@description('Tags of the Purview Account')
param tags object = {
  displayName: purviewAcctName
  environment: env
  domain: 'Data Management'
  cloudscale: 'DMLZ'
  product: 'purview'
  owner: 'frgarofa'
  costCenter: '12345'
}

@description('Allow Public Network Access')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'


resource purviewAcct 'Microsoft.Purview/accounts@2021-12-01' = {
  name: '${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-{env}'
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
  resource kafkaConfig 'kafkaConfigurations' = {
    name: 'default'
    properties: {
      consumerGroup: 'purview'
      credentials:  {
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

resource privateEndPoint 'Microsoft.Network/privateEndpoints@2023-04-01' = {
  name: ' ${toLower(purviewAcctName)}-${uniqueString(resourceGroup().id)}-${env}-pep'
  location: location
  properties: {
    subnet: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.Network/virtualNetworks/${purviewAcct.properties.managedResourceGroupName}/subnets/default'
    }
    privateLinkServiceConnections: [
      {
        name: 'purviewAcct'
        properties: {
          privateLinkServiceId: purviewAcct.id
          groupIds: [
            'dataPlane'
          ]
        }
      }
    ]
  }
}

resource pepConfig 'Microsoft.Purview/accounts/privateEndpointConnections@2021-12-01' = {
  name: 'purviewAcct/default'
  properties: {
    privateEndpoint: {
      id: '/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.Network/privateEndpoints/${purviewAcct.properties.name}'
    }
    privateLinkServiceConnectionState: {
      status: 'Approved'
      description: 'DMLZ PEP Approved'
    }
    
  }
}


