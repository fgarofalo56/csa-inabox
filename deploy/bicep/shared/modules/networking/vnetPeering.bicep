// =============================================================================
// CSA-in-a-Box: VNet Peering Module
// Creates bidirectional VNet peering between a hub and a spoke VNet.
// =============================================================================
targetScope = 'resourceGroup'

// Parameters
@description('Name of the hub VNet')
param parHubVnetName string

@description('Resource ID of the hub VNet')
param parHubVnetId string

@description('Name of the spoke VNet')
param parSpokeVnetName string

@description('Resource ID of the spoke VNet')
param parSpokeVnetId string

@description('Allow the hub gateway to forward traffic to the spoke')
param parAllowGatewayTransit bool = true

@description('Allow the spoke to use the hub VPN/ER gateway')
param parUseRemoteGateways bool = false

@description('Allow forwarded traffic from the spoke')
param parAllowForwardedTraffic bool = true

// Hub → Spoke peering
resource hubToSpokePeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  name: '${parHubVnetName}/peer-to-${parSpokeVnetName}'
  properties: {
    remoteVirtualNetwork: {
      id: parSpokeVnetId
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: parAllowForwardedTraffic
    allowGatewayTransit: parAllowGatewayTransit
    useRemoteGateways: false
  }
}

// Spoke → Hub peering
resource spokeToHubPeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  name: '${parSpokeVnetName}/peer-to-${parHubVnetName}'
  properties: {
    remoteVirtualNetwork: {
      id: parHubVnetId
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: parAllowForwardedTraffic
    allowGatewayTransit: false
    useRemoteGateways: parUseRemoteGateways
  }
}

// Outputs
output hubToSpokePeeringId string = hubToSpokePeering.id
output spokeToHubPeeringId string = spokeToHubPeering.id
