// DMLZ Governance Databricks Workspace
// Shared governance workspace in DMLZ for Unity Catalog and cross-domain governance
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Databricks governance workspace.')
param workspaceName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Managed resource group name.')
param managedResourceGroupName string = '${workspaceName}-managed-rg'

@description('Resource ID of the VNet for VNet injection.')
param vnetId string = ''

@description('Name of the public (host) subnet.')
param publicSubnetName string = 'databricks-gov-public'

@description('Name of the private (container) subnet.')
param privateSubnetName string = 'databricks-gov-private'

@description('Enable No Public IP.')
param enableNoPublicIp bool = true

@description('Public network access.')
param publicNetworkAccess string = 'Disabled'

@description('NSG rules setting.')
param requiredNsgRules string = 'NoAzureDatabricksRules'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID (privatelink.azuredatabricks.net).')
param privateDnsZoneId string = ''

@description('Resource ID of the Log Analytics workspace.')
param logAnalyticsWorkspaceId string = ''

// Variables
var managedRgId = '${subscription().id}/resourceGroups/${managedResourceGroupName}'

// Resources
resource databricksWorkspace 'Microsoft.Databricks/workspaces@2024-05-01' = {
  name: workspaceName
  location: location
  tags: union(tags, { Role: 'Governance', UnityCatalog: 'true' })
  sku: {
    name: 'premium'
  }
  properties: {
    managedResourceGroupId: managedRgId
    publicNetworkAccess: publicNetworkAccess
    requiredNsgRules: requiredNsgRules
    parameters: {
      enableNoPublicIp: {
        value: enableNoPublicIp
      }
      customVirtualNetworkId: {
        value: !empty(vnetId) ? vnetId : ''
      }
      customPublicSubnetName: {
        value: !empty(vnetId) ? publicSubnetName : ''
      }
      customPrivateSubnetName: {
        value: !empty(vnetId) ? privateSubnetName : ''
      }
    }
  }
}

// Private Endpoints
resource databricksPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${workspaceName}-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${workspaceName}-databricks_ui_api'
          properties: {
            privateLinkServiceId: databricksWorkspace.id
            groupIds: [
              'databricks_ui_api'
            ]
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource databricksPrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneId)) {
    parent: databricksPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${workspaceName}-dns-config'
          properties: {
            privateDnsZoneId: privateDnsZoneId
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource databricksDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${workspaceName}-diagnostics'
  scope: databricksWorkspace
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'dbfs', enabled: true }
      { category: 'clusters', enabled: true }
      { category: 'accounts', enabled: true }
      { category: 'jobs', enabled: true }
      { category: 'notebook', enabled: true }
      { category: 'workspace', enabled: true }
      { category: 'secrets', enabled: true }
      { category: 'unityCatalog', enabled: true }
      { category: 'repos', enabled: true }
      { category: 'mlflowExperiment', enabled: true }
      { category: 'modelRegistry', enabled: true }
    ]
  }
}

// Outputs
@description('Resource ID of the governance Databricks workspace.')
output workspaceId string = databricksWorkspace.id

@description('URL of the workspace.')
output workspaceUrl string = databricksWorkspace.properties.workspaceUrl

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = databricksWorkspace.identity.principalId
