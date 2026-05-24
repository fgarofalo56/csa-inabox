// CSA Loom — Point-to-Site VPN Gateway
//
// Federal-admin laptops connect via AAD-authenticated P2S VPN. The
// gateway sits in the hub VNet's GatewaySubnet (/27) and uses Azure
// AD for auth (no per-user certs to manage). The OpenVPN tunnel
// type is the only one that supports AAD auth.
//
// Cost: ~$30/mo for VpnGw1 + ~$0.04/conn-hr.
// Provisioning time: 30-45 min (Azure VNet Gateways are slow).

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('GatewaySubnet ID (must be the canonical name, /27 minimum)')
param gatewaySubnetId string

@description('Address pool for P2S clients (must NOT overlap hub or DLZ VNets)')
param vpnClientAddressPool string = '172.16.201.0/24'

@description('Entra (Azure AD) tenant ID for VPN client auth')
param tenantId string = subscription().tenantId

@description('SKU — VpnGw1 is cheapest. Bump to VpnGw2 for >10 concurrent users.')
@allowed(['VpnGw1', 'VpnGw2', 'VpnGw3'])
param sku string = 'VpnGw1'

@description('Compliance tags')
param complianceTags object

resource vpnPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-vpn-loom-${location}'
  location: location
  tags: complianceTags
  sku: { name: 'Standard' }
  zones: ['1', '2', '3']
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

// The audience GUID 'c632b3df-fb67-4d84-bdcf-b95ad541b5c8' is Microsoft's
// reserved app ID for Azure VPN — clients present a token with this aud
// claim when authenticating against AAD.
var azureVpnClientAppId = '41b23e61-6c1e-4545-b367-cd054e0ed4b4'

resource vpnGateway 'Microsoft.Network/virtualNetworkGateways@2024-05-01' = {
  name: 'vgw-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    gatewayType: 'Vpn'
    vpnType: 'RouteBased'
    enableBgp: false
    activeActive: false
    sku: {
      name: sku
      tier: sku
    }
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: gatewaySubnetId }
          publicIPAddress: { id: vpnPip.id }
        }
      }
    ]
    vpnClientConfiguration: {
      vpnClientAddressPool: {
        addressPrefixes: [vpnClientAddressPool]
      }
      vpnClientProtocols: ['OpenVPN']
      vpnAuthenticationTypes: ['AAD']
      aadTenant: 'https://login.microsoftonline.com/${tenantId}'
      aadAudience: azureVpnClientAppId
      aadIssuer: 'https://sts.windows.net/${tenantId}/'
    }
  }
}

output vpnGatewayId string = vpnGateway.id
output vpnGatewayName string = vpnGateway.name
output vpnPublicIp string = vpnPip.properties.ipAddress
