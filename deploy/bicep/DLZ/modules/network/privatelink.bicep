// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

targetScope = 'resourceGroup'

// Parameters
@description('Service ID for the Private Endpoint')
param serviceId string

@description('Service sub resource')
param serviceSubResource string

@description('Tags for resource organization')
param tags object

@description('List of Private Endpoint Subnet details')
param privateEndpointSubnets array

@description('Private DNS zone Location Information')
param privateDNSZones object

@description('Service Name for the Private Endpoint')
param serviceName string

// Variables
var basePrivateEndpointName = replace(replace(toLower('${serviceName}-${serviceSubResource}'), ' ', ''), '_', '-')
// Ensure the base name is not longer than 40 characters
var trimmedPrivateEndpointName = length(basePrivateEndpointName) > 40
  ? substring(basePrivateEndpointName, 0, 40)
  : basePrivateEndpointName

// Resources
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = [
  for peSubnet in privateEndpointSubnets: {
    name: '${trimmedPrivateEndpointName}-${peSubnet.vNetName}-pe'
    tags: tags
    location: peSubnet.vNetLocation
    properties: {
      subnet: {
        id: resourceId(
          peSubnet.subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
      privateLinkServiceConnections: [
        {
          name: '${trimmedPrivateEndpointName}-${peSubnet.vNetName}-connection'
          properties: {
            privateLinkServiceId: serviceId
            groupIds: [serviceSubResource]
          }
        }
      ]
    }
  }
]

// Private DNS Zone Group for Blob
resource privateEndpointARecords 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDNSZones.subscriptionId)) {
    parent: privateEndpoint[i]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${trimmedPrivateEndpointName}-${peSubnet.vNetName}-arecord'
          properties: {
            privateDnsZoneId: contains(['usgovvirginia', 'usgovarizona', 'usgovtexas'], toLower(peSubnet.vNetLocation))
              ? '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.usgovcloudapi.net'
              : '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net'
          }
        }
      ]
    }
  }
]
