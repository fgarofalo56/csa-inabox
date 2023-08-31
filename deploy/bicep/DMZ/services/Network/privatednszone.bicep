targetScope = 'resourceGroup'

// Parameters
@allowed([
  'dev'
  'test'
  'prod'
])
@minLength(2)
@maxLength(10)
@description('Deployment Environment')
param env string
param vNetName string
param tags object
param exists bool
param pzone string


// Variables
var vnetId = resourceId('Microsoft.Network/virtualNetworks', vNetName)
// Resources
resource privateDnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: pzone
  location: 'global'
  tags: tags
  properties: {}
}

resource virtualNetworkLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (!exists) {
  name: '${vNetName}-${env}'
  location: 'global'
  tags: tags
  parent: privateDnsZones
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

