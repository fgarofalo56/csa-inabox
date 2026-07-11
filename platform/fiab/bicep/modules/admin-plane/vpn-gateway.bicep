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
// authenticating against Entra ID). Microsoft Learn "About Point-to-Site VPN —
// How are P2S VPN clients authenticated?" lists two registration models:
//   Microsoft-registered (universal, pre-consented, NO manual app registration):
//     c632b3df-fb67-4d84-bdcf-b95ad541b5c8 — valid for Azure Public, Azure
//     Government, Azure Germany and 21Vianet. Microsoft recommends this value;
//     the tenant can use it with no extra registration steps.
//   Manually-registered (requires a Cloud Application Administrator to register
//     + consent the Azure VPN Enterprise App in the tenant BEFORE it is usable):
//     Azure Public     : 41b23e61-6c1e-4545-b367-cd054e0ed4b4
//     Azure Government : 51bb15d4-3a4f-4ebf-9dca-40096fe32426
// Round-4 (#1887) used the manually-registered Gov GUID (51bb15d4…) for
// GCC-High / IL5, but a live usgovvirginia deploy STILL failed preflight with
// VpnClientConfigurationAadTenantIsNotValid — that app is not registered /
// consented in the Gov Entra tenant, and the gateway rejects an audience it
// cannot resolve. Gov therefore uses the Microsoft-registered universal audience
// (c632b3df…): no tenant bootstrap, works day-one (no-vaporware). Commercial /
// GCC keep their existing manually-registered Public GUID unchanged
// (byte-identical). aadTenant (environment().authentication.loginEndpoint →
// https://login.microsoftonline.us/<tenant> in Gov) and aadIssuer
// (https://sts.windows.net/<tenant>/, cloud-agnostic per Learn) are already
// correct across clouds.
var azureVpnClientAppId = (boundary == 'GCC-High' || boundary == 'IL5') ? 'c632b3df-fb67-4d84-bdcf-b95ad541b5c8' : '41b23e61-6c1e-4545-b367-cd054e0ed4b4'

// Normalize the sovereign login endpoint to EXACTLY one trailing slash before
// appending the tenant GUID. ARM's environment().authentication.loginEndpoint
// includes a trailing slash on Azure Public (https://login.microsoftonline.com/)
// but NOT on Azure Government (https://login.microsoftonline.us) — a live
// usgovvirginia deploy (2026-07-11) failed preflight with
// VpnClientConfigurationAadTenantIsNotValid ("AAD Tenant must contain a valid
// AAD Directory ID (Guid)") because the un-slashed Gov endpoint glued straight
// onto the GUID (…microsoftonline.us03f141f3-…), leaving no parseable Directory
// ID. Trimming then re-appending one slash yields …/<guid> in every cloud.
var loginEndpointRaw = environment().authentication.loginEndpoint
var aadTenantUrl = '${loginEndpointRaw}${endsWith(loginEndpointRaw, '/') ? '' : '/'}${tenantId}'

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
      aadTenant: aadTenantUrl
      aadAudience: azureVpnClientAppId
      aadIssuer: 'https://sts.windows.net/${tenantId}/'
    }
  }
}

output vpnGatewayId string = vpnGateway.id
output vpnGatewayName string = vpnGateway.name
output vpnPublicIp string = vpnPip.properties.ipAddress
