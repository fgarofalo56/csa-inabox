// Azure Resource Manager (ARM) Template: Private DNS Zone
// Creates a private DNS zone and links it to a virtual network
// https://docs.microsoft.com/en-us/azure/templates/microsoft.network/2020-06-01/privateDnsZones/virtualNetworkLinks

// Parameters
param env string
param vNetName string
param tags object
param exists bool
param pzone string

// Variables

var vnetId = resourceId('Microsoft.Network/virtualNetworks', vNetName)
// Resources

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' =  {
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

