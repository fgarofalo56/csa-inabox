// Azure Databricks Workspace Module
// Deploys a Premium Databricks workspace with VNet injection, private endpoints, and managed identity
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Databricks workspace.')
param workspaceName string

@description('Azure region for the workspace.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Managed resource group name for Databricks-managed resources.')
param managedResourceGroupName string = '${workspaceName}-managed-rg'

@description('Pricing tier for the workspace.')
@allowed([
  'premium'
  'standard'
  'trial'
])
param pricingTier string = 'premium'

@description('Resource ID of the VNet for VNet injection.')
param vnetId string = ''

@description('Name of the public (host) subnet for Databricks.')
param publicSubnetName string = 'databricks-public'

@description('Name of the private (container) subnet for Databricks.')
param privateSubnetName string = 'databricks-private'

@description('Enable No Public IP for enhanced security.')
param enableNoPublicIp bool = true

@description('Disable public network access to the workspace.')
param publicNetworkAccess string = 'Disabled'

@description('Required NSG rules for the workspace.')
param requiredNsgRules string = 'NoAzureDatabricksRules'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID for Databricks workspace (privatelink.azuredatabricks.net).')
param privateDnsZoneId string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

// Variables
var managedRgId = '${subscription().id}/resourceGroups/${managedResourceGroupName}'

// Resources
resource databricksWorkspace 'Microsoft.Databricks/workspaces@2024-05-01' = {
  name: workspaceName
  location: location
  tags: tags
  sku: {
    name: pricingTier
  }
  identity: {
    type: 'SystemAssigned'
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
      { category: 'dbfs'; enabled: true }
      { category: 'clusters'; enabled: true }
      { category: 'accounts'; enabled: true }
      { category: 'jobs'; enabled: true }
      { category: 'notebook'; enabled: true }
      { category: 'ssh'; enabled: true }
      { category: 'workspace'; enabled: true }
      { category: 'secrets'; enabled: true }
      { category: 'sqlPermissions'; enabled: true }
      { category: 'instancePools'; enabled: true }
      { category: 'sqlanalytics'; enabled: true }
      { category: 'genie'; enabled: true }
      { category: 'globalInitScripts'; enabled: true }
      { category: 'iamRole'; enabled: true }
      { category: 'mlflowExperiment'; enabled: true }
      { category: 'featureStore'; enabled: true }
      { category: 'RemoteHistoryService'; enabled: true }
      { category: 'mlflowAcledArtifact'; enabled: true }
      { category: 'databrickssql'; enabled: true }
      { category: 'deltaPipelines'; enabled: true }
      { category: 'modelRegistry'; enabled: true }
      { category: 'repos'; enabled: true }
      { category: 'unityCatalog'; enabled: true }
      { category: 'gitCredentials'; enabled: true }
      { category: 'webTerminal'; enabled: true }
      { category: 'serverlessRealTimeInference'; enabled: true }
      { category: 'clusterLibraries'; enabled: true }
      { category: 'partnerHub'; enabled: true }
      { category: 'clamAVScan'; enabled: true }
      { category: 'capsule8Dataplane'; enabled: true }
    ]
  }
}

// Outputs
@description('Resource ID of the Databricks workspace.')
output workspaceId string = databricksWorkspace.id

@description('URL of the Databricks workspace.')
output workspaceUrl string = databricksWorkspace.properties.workspaceUrl

@description('Managed identity principal ID of the workspace.')
output managedIdentityPrincipalId string = databricksWorkspace.identity.principalId

@description('Managed resource group ID.')
output managedResourceGroupId string = databricksWorkspace.properties.managedResourceGroupId
