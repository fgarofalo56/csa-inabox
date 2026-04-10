// =============================================================================
// CSA-in-a-Box: Spoke VNet Module
// Creates a spoke virtual network for DMLZ or DLZ workloads.
// Subnets are parameterised so each deployment can specify its own layout
// with optional NSG and UDR associations.
// =============================================================================
targetScope = 'resourceGroup'

// Parameters
@description('Azure region for deployment')
param parLocation string

@description('Spoke VNet name')
param parVnetName string

@description('Address space for the spoke VNet in CIDR notation (e.g. 10.1.0.0/16)')
param parVnetAddressPrefix string

@description('Tags for resource organisation')
param parTags object = {}

@description('Array of subnet definitions.  Each element must have name + addressPrefix; nsgId and routeTableId are optional.')
param parSubnets array

@description('Log Analytics workspace resource ID for VNet diagnostics.  Leave empty to skip.')
param parLogAnalyticsWorkspaceId string = ''

// Spoke VNet
resource spokeVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: parVnetName
  location: parLocation
  tags: parTags
  properties: {
    addressSpace: {
      addressPrefixes: [parVnetAddressPrefix]
    }
    subnets: [
      for subnet in parSubnets: {
        name: subnet.name
        properties: {
          addressPrefix: subnet.addressPrefix
          networkSecurityGroup: contains(subnet, 'nsgId') && !empty(subnet.nsgId) ? { id: subnet.nsgId } : null
          routeTable: contains(subnet, 'routeTableId') && !empty(subnet.routeTableId) ? { id: subnet.routeTableId } : null
          privateEndpointNetworkPolicies: 'Enabled'
          serviceEndpoints: contains(subnet, 'serviceEndpoints') ? subnet.serviceEndpoints : []
        }
      }
    ]
  }
}

// Diagnostic settings
resource spokeVnetDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(parLogAnalyticsWorkspaceId)) {
  name: '${parVnetName}-diagnostics'
  scope: spokeVnet
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
output spokeVnetId string = spokeVnet.id
output spokeVnetName string = spokeVnet.name
output subnetIds object = reduce(
  map(spokeVnet.properties.subnets, s => { '${s.name}': s.id }),
  {},
  (cur, acc) => union(acc, cur)
)
