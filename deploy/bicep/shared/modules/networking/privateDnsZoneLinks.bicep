// =============================================================================
// CSA-in-a-Box: Private DNS Zone VNet Links (helper)
// Links a single private DNS zone to one or more VNets.  Called from
// privateDnsZones.bicep to avoid BCP247 (lambda in resource array access).
// =============================================================================
targetScope = 'resourceGroup'

@description('Name of the existing private DNS zone to link')
param parDnsZoneName string

@description('Array of VNet resource IDs to link')
param parVnetIds array

@description('Prefix used in the link resource name for uniqueness')
param parLinkPrefix string

@description('Tags for resource organisation')
param parTags object = {}

// Reference the existing DNS zone
resource dnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' existing = {
  name: parDnsZoneName
}

// Create a VNet link for each supplied VNet
resource vnetLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (vnetId, idx) in parVnetIds: {
    parent: dnsZone
    name: '${parLinkPrefix}-link-${idx}'
    location: 'global'
    tags: parTags
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: vnetId
      }
    }
  }
]
