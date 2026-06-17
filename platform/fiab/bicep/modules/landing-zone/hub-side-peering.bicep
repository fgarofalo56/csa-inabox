// CSA Loom — hub→DLZ reverse VNet peering (cross-subscription)
//
// dlz-attach ONLY. The DLZ→hub peering is created inside the DLZ VNet by
// landing-zone/network.bicep (`peer-to-admin-hub`). On a cross-sub dlz-attach the
// deployment is submitted at the DLZ subscription scope, so it can ONLY create
// resources in the DLZ sub — the REVERSE peering (in the HUB VNet, in the HUB
// subscription) is never made and the peering stays "Initiated" forever. The
// hub console then can't route to the private DLZ resources.
//
// main.bicep deploys THIS module cross-sub via
//   scope: resourceGroup(hubSubscriptionId, hubAdminRgName)
// so it lands the hub-side peering in the hub VNet, in the hub sub. With both
// halves present the peering reaches "Connected".
//
// This mirrors landing-zone/network.bicep's `peerToHub` (same flags) but from the
// hub's point of view: remoteVirtualNetwork = the DLZ spoke VNet id.

targetScope = 'resourceGroup'

@description('Name of the EXISTING hub VNet (in this RG/sub) to add the reverse peering to.')
param hubVnetName string

@description('Resource id of the DLZ spoke VNet this hub peers TO (the remote network).')
param dlzSpokeVnetId string

@description('Domain name of the attached DLZ — used to name the peering deterministically so re-attaching another domain does not collide.')
param domainName string

// Existing hub VNet (in the hub subscription / admin RG — this module's scope).
resource hubVnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: hubVnetName
}

// Reverse peering: hub → DLZ. Mirrors the DLZ→hub peering's flags
// (allowVirtualNetworkAccess + allowForwardedTraffic). No gateway transit — the
// DLZ side sets useRemoteGateways:false, so neither half advertises a gateway.
resource peerToDlz 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  parent: hubVnet
  name: 'peer-to-dlz-${domainName}'
  properties: {
    remoteVirtualNetwork: { id: dlzSpokeVnetId }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

output peeringName string = peerToDlz.name
output peeringId string = peerToDlz.id
