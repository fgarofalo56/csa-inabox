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

@description('Cloud boundary — selects the sovereign Azure VPN Client audience app ID. Azure Government uses a different Microsoft-managed Azure VPN app registration than Commercial, so a P2S gateway in Gov must present the Gov audience GUID or the config is rejected.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string = 'Commercial'

@description('SKU - VpnGw1AZ is the smallest zone-redundant SKU. Non-AZ VpnGw1-5 are no longer accepted (Azure deprecation 2026).')
@allowed(['VpnGw1AZ', 'VpnGw2AZ', 'VpnGw3AZ'])
param sku string = 'VpnGw1AZ'

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

// Azure VPN Client audience app ID (the "aud" claim clients present when
// authenticating against Entra ID). This is the manually-registered Azure VPN
// Enterprise App ID, and it differs per national cloud — Microsoft Learn
// "Configure P2S VPN gateway for Entra ID authentication" lists:
//   Azure Public     : 41b23e61-6c1e-4545-b367-cd054e0ed4b4
//   Azure Government  : 51bb15d4-3a4f-4ebf-9dca-40096fe32426
// A Gov gateway configured with the Public GUID fails preflight
// (VpnClientConfigurationAadTenantIsNotValid), so select per boundary. The
// aadTenant (environment().authentication.loginEndpoint → login.microsoftonline.us
// in Gov) and aadIssuer (sts.windows.net, cloud-agnostic per Learn) are already
// correct across clouds. Commercial keeps the Public GUID (byte-identical).
var azureVpnClientAppId = (boundary == 'GCC-High' || boundary == 'IL5') ? '51bb15d4-3a4f-4ebf-9dca-40096fe32426' : '41b23e61-6c1e-4545-b367-cd054e0ed4b4'

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
      aadTenant: '${environment().authentication.loginEndpoint}${tenantId}'
      aadAudience: azureVpnClientAppId
      aadIssuer: 'https://sts.windows.net/${tenantId}/'
    }
  }
}

output vpnGatewayId string = vpnGateway.id
output vpnGatewayName string = vpnGateway.name
output vpnPublicIp string = vpnPip.properties.ipAddress
