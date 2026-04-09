// Shared module: Private Endpoint with DNS Zone Group
// Reusable across all service modules for consistent PE creation
targetScope = 'resourceGroup'

// Parameters
@description('Name for the private endpoint resource.')
param name string

@description('Azure region for the private endpoint.')
param location string

@description('Resource ID of the service to connect to via private link.')
param privateLinkServiceId string

@description('The group ID (subresource) for the private link connection.')
param groupId string

@description('Resource ID of the subnet where the PE will be placed.')
param subnetId string

@description('Resource ID of the Private DNS Zone for A-record registration. Leave empty to skip DNS.')
param privateDnsZoneId string = ''

@description('Tags to apply to the private endpoint.')
param tags object = {}

// Resources
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: privateLinkServiceId
          groupIds: [
            groupId
          ]
        }
      }
    ]
    subnet: {
      id: subnetId
    }
  }
}

resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(privateDnsZoneId)) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: '${name}-config'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

// Outputs
@description('Resource ID of the private endpoint.')
output privateEndpointId string = privateEndpoint.id

@description('Name of the private endpoint.')
output privateEndpointName string = privateEndpoint.name

@description('Network interface IDs associated with the private endpoint.')
output networkInterfaceIds array = privateEndpoint.properties.networkInterfaces
