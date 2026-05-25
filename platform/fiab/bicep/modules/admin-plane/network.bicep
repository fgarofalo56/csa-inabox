// CSA Loom — Admin Plane network foundation
// Hub VNet with subnets for Container Apps Env / AKS, Function App,
// APIM, Private Endpoints, Azure Firewall, Bastion.
// Private DNS zones for all PaaS dependencies.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Hub VNet CIDR')
param hubVnetCidr string

@description('Cloud boundary — affects DNS suffix selection')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Container platform — determines subnet sizing')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Log Analytics workspace ID for diagnostic settings (optional in first-pass deploy; re-apply once monitoring is provisioned)')
param workspaceId string = ''

@description('Compliance tags')
param complianceTags object

// =====================================================================
// Subnet calculations
// =====================================================================

// Subnet layout under hubVnetCidr (e.g., 10.0.0.0/16):
// 10.0.0.0/24    - AzureFirewallSubnet
// 10.0.1.0/26    - AzureBastionSubnet
// 10.0.2.0/24    - ContainerAppsEnv / AKS nodes
// 10.0.3.0/24    - Function App (VNet integration)
// 10.0.4.0/24    - APIM internal
// 10.0.5.0/24    - Private Endpoints
// 10.0.6.0/24    - Reserved (future agent runtimes)
// 10.0.7.0/27    - GatewaySubnet (P2S/S2S VPN; /27 is the AzureRM minimum)
// 10.0.8.0/24    - snet-appgw (App Gateway v2 + WAF)

var firstOctets = take(split(hubVnetCidr, '.'), 2)
var prefix = '${firstOctets[0]}.${firstOctets[1]}'

var subnets = [
  {
    name: 'AzureFirewallSubnet'
    addressPrefix: '${prefix}.0.0/24'
  }
  {
    name: 'AzureBastionSubnet'
    addressPrefix: '${prefix}.1.0/26'
  }
  {
    name: 'snet-container-platform'
    addressPrefix: '${prefix}.2.0/24'
    delegations: containerPlatform == 'containerApps' ? [
      {
        name: 'Microsoft.App/environments'
        properties: { serviceName: 'Microsoft.App/environments' }
      }
    ] : []
  }
  {
    name: 'snet-functions'
    addressPrefix: '${prefix}.3.0/24'
    delegations: [
      {
        name: 'Microsoft.Web/serverFarms'
        properties: { serviceName: 'Microsoft.Web/serverFarms' }
      }
    ]
  }
  {
    name: 'snet-apim'
    addressPrefix: '${prefix}.4.0/24'
    delegations: [
      {
        name: 'Microsoft.Web/hostingEnvironments'
        properties: { serviceName: 'Microsoft.Web/hostingEnvironments' }
      }
    ]
  }
  {
    name: 'snet-private-endpoints'
    addressPrefix: '${prefix}.5.0/24'
    privateEndpointNetworkPolicies: 'Disabled'
  }
  {
    name: 'snet-reserved'
    addressPrefix: '${prefix}.6.0/24'
  }
  {
    name: 'GatewaySubnet'
    addressPrefix: '${prefix}.7.0/27'
  }
  {
    name: 'snet-appgw'
    addressPrefix: '${prefix}.8.0/24'
    delegations: [
      {
        name: 'Microsoft.Network/applicationGateways'
        properties: { serviceName: 'Microsoft.Network/applicationGateways' }
      }
    ]
  }
]

// =====================================================================
// Hub VNet
// =====================================================================

resource hubVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-csa-loom-hub-${location}'
  location: location
  tags: complianceTags
  properties: {
    addressSpace: {
      addressPrefixes: [hubVnetCidr]
    }
    subnets: [for s in subnets: {
      name: s.name
      properties: union(
        { addressPrefix: s.addressPrefix },
        contains(s, 'delegations') ? { delegations: s.delegations } : {},
        contains(s, 'privateEndpointNetworkPolicies') ? { privateEndpointNetworkPolicies: s.privateEndpointNetworkPolicies } : {}
      )
    }]
  }
}

// =====================================================================
// Network Security Groups (per non-system subnet)
// =====================================================================

var nsgSubnets = filter(subnets, s => !startsWith(s.name, 'Azure') && s.name != 'GatewaySubnet')

// Associate NSGs with their corresponding subnets (required by APIM,
// recommended for all workload subnets). One subnet/NSG update per
// non-system subnet — runs after both VNet and NSG resources exist.
@batchSize(1)
resource subnetNsgAttach 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = [for (s, i) in nsgSubnets: {
  parent: hubVnet
  name: s.name
  properties: union(
    { addressPrefix: s.addressPrefix, networkSecurityGroup: { id: nsgs[i].id } },
    contains(s, 'delegations') ? { delegations: s.delegations } : {},
    contains(s, 'privateEndpointNetworkPolicies') ? { privateEndpointNetworkPolicies: s.privateEndpointNetworkPolicies } : {}
  )
}]

resource nsgs 'Microsoft.Network/networkSecurityGroups@2024-05-01' = [for s in nsgSubnets: {
  name: 'nsg-${s.name}'
  location: location
  tags: complianceTags
  properties: {
    securityRules: [
      {
        name: 'DenyInternetInbound'
        properties: {
          priority: 4000
          access: 'Deny'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'AllowVnetInbound'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
    ]
  }
}]

// =====================================================================
// Azure Bastion (Standard SKU for IL5 compliance)
// =====================================================================

resource bastionPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-bastion-csa-loom-${location}'
  location: location
  tags: complianceTags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource bastion 'Microsoft.Network/bastionHosts@2024-05-01' = {
  name: 'bastion-csa-loom-${location}'
  location: location
  tags: complianceTags
  sku: { name: 'Standard' }
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig'
        properties: {
          subnet: {
            id: '${hubVnet.id}/subnets/AzureBastionSubnet'
          }
          publicIPAddress: { id: bastionPip.id }
        }
      }
    ]
    enableTunneling: true
  }
}

// =====================================================================
// Azure Firewall (Premium for TLS inspection in Gov)
// =====================================================================

var firewallSku = boundary == 'IL5' || boundary == 'GCC-High' ? 'Premium' : 'Standard'

resource firewallPolicy 'Microsoft.Network/firewallPolicies@2024-05-01' = {
  name: 'fwpol-csa-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    sku: { tier: firewallSku }
    threatIntelMode: 'Alert'
  }
}

resource firewallPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-fw-csa-loom-${location}'
  location: location
  tags: complianceTags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2024-05-01' = {
  name: 'fw-csa-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    sku: {
      name: 'AZFW_VNet'
      tier: firewallSku
    }
    firewallPolicy: { id: firewallPolicy.id }
    ipConfigurations: [
      {
        name: 'ipconfig'
        properties: {
          subnet: {
            id: '${hubVnet.id}/subnets/AzureFirewallSubnet'
          }
          publicIPAddress: { id: firewallPip.id }
        }
      }
    ]
  }
}

// =====================================================================
// Private DNS zones for every PaaS dependency
// =====================================================================

var dnsZones = [
  'privatelink.vaultcore.azure.net'
  'privatelink.azurecr.io'
  'privatelink.blob.${boundary == 'GCC-High' || boundary == 'IL5' ? 'core.usgovcloudapi.net' : 'core.windows.net'}'
  'privatelink.dfs.${boundary == 'GCC-High' || boundary == 'IL5' ? 'core.usgovcloudapi.net' : 'core.windows.net'}'
  'privatelink.azconfig.io'
  'privatelink.cognitiveservices.azure.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'com'}'
  'privatelink.openai.azure.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'com'}'
  'privatelink.search.windows.net'
  'privatelink.documents.azure.com'
  'privatelink.servicebus.windows.net'
  'privatelink.eventgrid.azure.net'
  'privatelink.azurewebsites.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'net'}'
  'privatelink.${location}.azurecontainerapps.io'
  'privatelink.azureml.ms'
  'privatelink.api.azureml.ms'
  'privatelink.notebooks.azure.net'
  'privatelink.${location}.kusto.windows.net'
  // v2.0 — Synapse SQL + Dev endpoints (Dedicated + Serverless + Studio)
  'privatelink.sql.azuresynapse.${boundary == 'GCC-High' || boundary == 'IL5' ? 'usgovcloudapi.net' : 'net'}'
  'privatelink.dev.azuresynapse.${boundary == 'GCC-High' || boundary == 'IL5' ? 'usgovcloudapi.net' : 'net'}'
  // v2 — Azure Data Factory (Pipeline / Dataset / Trigger editors)
  'privatelink.${boundary == 'GCC-High' || boundary == 'IL5' ? 'datafactory.azure.us' : 'adf.azure.com'}'
]

resource privateDnsZones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in dnsZones: {
  name: zone
  location: 'global'
  tags: complianceTags
}]

resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in dnsZones: {
  name: '${zone}/link-hub-${uniqueString(hubVnet.id)}'
  location: 'global'
  dependsOn: [ privateDnsZones[i] ]
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: hubVnet.id }
  }
}]

// =====================================================================
// Outputs
// =====================================================================

// Diagnostic settings → standardized Loom LAW
resource diagVnet 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: hubVnet
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'VMProtectionAlerts', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource diagFw 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: firewall
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource diagBastion 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: bastion
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'BastionAuditLogs', enabled: true }
    ]
  }
}

output hubVnetId string = hubVnet.id
output hubVnetName string = hubVnet.name
output firewallPrivateIp string = firewall.properties.ipConfigurations[0].properties.privateIPAddress
output bastionId string = bastion.id
output containerPlatformSubnetId string = '${hubVnet.id}/subnets/snet-container-platform'
output functionsSubnetId string = '${hubVnet.id}/subnets/snet-functions'
output apimSubnetId string = '${hubVnet.id}/subnets/snet-apim'
output privateEndpointsSubnetId string = '${hubVnet.id}/subnets/snet-private-endpoints'
output gatewaySubnetId string = '${hubVnet.id}/subnets/GatewaySubnet'
output appGatewaySubnetId string = '${hubVnet.id}/subnets/snet-appgw'
output privateDnsZoneIds object = {
  keyvault: privateDnsZones[0].id
  acr: privateDnsZones[1].id
  blob: privateDnsZones[2].id
  dfs: privateDnsZones[3].id
  appconfig: privateDnsZones[4].id
  cognitiveservices: privateDnsZones[5].id
  openai: privateDnsZones[6].id
  search: privateDnsZones[7].id
  cosmos: privateDnsZones[8].id
  servicebus: privateDnsZones[9].id
  eventgrid: privateDnsZones[10].id
  webapp: privateDnsZones[11].id
  containerapps: privateDnsZones[12].id
  azureml: privateDnsZones[13].id
  azuremlapi: privateDnsZones[14].id
  notebooks: privateDnsZones[15].id
  kusto: privateDnsZones[16].id
  synapseSql: privateDnsZones[17].id
  synapseDev: privateDnsZones[18].id
}
