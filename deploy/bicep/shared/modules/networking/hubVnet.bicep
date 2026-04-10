// =============================================================================
// CSA-in-a-Box: Hub VNet Module
// Creates a hub virtual network with well-known subnets for Azure Firewall,
// VPN/ER Gateway, Bastion, and management workloads.
// =============================================================================
targetScope = 'resourceGroup'

// Parameters
@description('Azure region for deployment')
param parLocation string

@description('Hub VNet name')
param parVnetName string

@description('Address space for the hub VNet in CIDR notation (e.g. 10.0.0.0/16)')
param parVnetAddressPrefix string

@description('Tags for resource organisation')
param parTags object = {}

@description('Optional DDoS Protection Plan resource ID.  Leave empty to skip.')
param parDdosProtectionPlanId string = ''

@description('Log Analytics workspace resource ID for VNet diagnostics.  Leave empty to skip.')
param parLogAnalyticsWorkspaceId string = ''

@description('NSG resource ID for the management subnet.  Leave empty to skip NSG association.')
param parManagementSubnetNsgId string = ''

// Subnet definitions — well-known Azure subnet names are required for Firewall,
// Gateway, and Bastion; we also add a management subnet for jump-boxes / tools.
var subnets = [
  {
    name: 'AzureFirewallSubnet'
    addressPrefix: cidrSubnet(parVnetAddressPrefix, 26, 0)   // /26 — Azure requires ≥ /26
    nsgId: ''  // NSG not supported on AzureFirewallSubnet
  }
  {
    name: 'GatewaySubnet'
    addressPrefix: cidrSubnet(parVnetAddressPrefix, 27, 2)    // /27 — minimum for VPN/ER Gateway
    nsgId: ''  // NSG not supported on GatewaySubnet
  }
  {
    name: 'AzureBastionSubnet'
    addressPrefix: cidrSubnet(parVnetAddressPrefix, 26, 1)    // /26 — Azure requires ≥ /26
    nsgId: ''  // Bastion has its own internal NSG
  }
  {
    name: 'ManagementSubnet'
    addressPrefix: cidrSubnet(parVnetAddressPrefix, 24, 1)    // /24
    nsgId: parManagementSubnetNsgId
  }
]

// Hub VNet
resource hubVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: parVnetName
  location: parLocation
  tags: parTags
  properties: {
    addressSpace: {
      addressPrefixes: [parVnetAddressPrefix]
    }
    ddosProtectionPlan: !empty(parDdosProtectionPlanId) ? {
      id: parDdosProtectionPlanId
    } : null
    enableDdosProtection: !empty(parDdosProtectionPlanId)
    subnets: [
      for subnet in subnets: {
        name: subnet.name
        properties: {
          addressPrefix: subnet.addressPrefix
          networkSecurityGroup: !empty(subnet.nsgId) ? { id: subnet.nsgId } : null
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
    ]
  }
}

// Diagnostic settings
resource hubVnetDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(parLogAnalyticsWorkspaceId)) {
  name: '${parVnetName}-diagnostics'
  scope: hubVnet
  properties: {
    workspaceId: parLogAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Outputs
output hubVnetId string = hubVnet.id
output hubVnetName string = hubVnet.name
output subnetIds object = reduce(
  map(hubVnet.properties.subnets, s => { '${s.name}': s.id }),
  {},
  (cur, acc) => union(acc, cur)
)
