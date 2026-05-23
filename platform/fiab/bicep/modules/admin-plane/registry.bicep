// CSA Loom — Admin Plane ACR (Premium with private link)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for ACR')
param privateDnsZoneAcrId string

@description('Compliance tags')
param complianceTags object

var acrName = take('acrloom${uniqueString(resourceGroup().id)}', 50)

resource acr 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: acrName
  location: location
  tags: complianceTags
  sku: { name: 'Premium' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
    zoneRedundancy: 'Enabled'
    policies: {
      retentionPolicy: {
        status: 'enabled'
        days: 30
      }
      quarantinePolicy: { status: 'enabled' }
      trustPolicy: {
        type: 'Notary'
        status: 'enabled'
      }
    }
  }
}

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${acrName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'acr-link'
        properties: {
          privateLinkServiceId: acr.id
          groupIds: ['registry']
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
      {
        name: 'acr-zone'
        properties: { privateDnsZoneId: privateDnsZoneAcrId }
      }
    ]
  }
}

output acrId string = acr.id
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
