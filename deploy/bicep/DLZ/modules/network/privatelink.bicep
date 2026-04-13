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

// Map of serviceSubResource values to their correct private DNS zone names.
// Each entry has a commercial (windows.net) and USGov (usgovcloudapi.net) suffix.
var dnsZoneMap = {
  blob: { commercial: 'privatelink.blob.core.windows.net', gov: 'privatelink.blob.core.usgovcloudapi.net' }
  dfs: { commercial: 'privatelink.dfs.core.windows.net', gov: 'privatelink.dfs.core.usgovcloudapi.net' }
  queue: { commercial: 'privatelink.queue.core.windows.net', gov: 'privatelink.queue.core.usgovcloudapi.net' }
  table: { commercial: 'privatelink.table.core.windows.net', gov: 'privatelink.table.core.usgovcloudapi.net' }
  file: { commercial: 'privatelink.file.core.windows.net', gov: 'privatelink.file.core.usgovcloudapi.net' }
  vault: { commercial: 'privatelink.vaultcore.azure.net', gov: 'privatelink.vaultcore.usgovcloudapi.net' }
  database: { commercial: 'privatelink.documents.azure.com', gov: 'privatelink.documents.azure.us' }
  sql: { commercial: 'privatelink.sql.azuresynapse.net', gov: 'privatelink.sql.azuresynapse.us' }
  namespace: { commercial: 'privatelink.servicebus.windows.net', gov: 'privatelink.servicebus.usgovcloudapi.net' }
  databricks: { commercial: 'privatelink.azuredatabricks.net', gov: 'privatelink.azuredatabricks.us' }
  sites: { commercial: 'privatelink.azurewebsites.net', gov: 'privatelink.azurewebsites.us' }
  azureml: { commercial: 'privatelink.api.azureml.ms', gov: 'privatelink.api.azureml.us' }
}

// Determine whether the location is a US Gov region
var isGovCloud = contains(['usgovvirginia', 'usgovarizona', 'usgovtexas'], toLower(serviceSubResource == serviceSubResource ? privateEndpointSubnets[0].vNetLocation : ''))

// Look up the DNS zone name for the given serviceSubResource; fall back to blob if not found
var dnsZoneEntry = contains(dnsZoneMap, serviceSubResource) ? dnsZoneMap[serviceSubResource] : dnsZoneMap.blob
var privateDnsZoneName = isGovCloud ? dnsZoneEntry.gov : dnsZoneEntry.commercial

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

// Private DNS Zone Group — uses the dnsZoneMap to resolve the correct zone per serviceSubResource
resource privateEndpointARecords 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [
  for (peSubnet, i) in privateEndpointSubnets: if (!empty(privateDNSZones.subscriptionId)) {
    parent: privateEndpoint[i]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${trimmedPrivateEndpointName}-${peSubnet.vNetName}-arecord'
          properties: {
            privateDnsZoneId: '/subscriptions/${privateDNSZones.subscriptionId}/resourceGroups/${privateDNSZones.resourceGroupName}/providers/Microsoft.Network/privateDnsZones/${privateDnsZoneName}'
          }
        }
      ]
    }
  }
]
