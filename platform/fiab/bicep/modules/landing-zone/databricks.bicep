// CSA Loom DLZ — Databricks workspace
// Premium tier; VNet-injected with private + public subnets
// Unity Catalog managed when supported in boundary; otherwise Hive metastore

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (suffix)')
param domainName string

@description('Spoke VNet name (must contain databricks-private + databricks-public subnets)')
param spokeVnetName string

@description('Private subnet name (delegated to Microsoft.Databricks/workspaces)')
param privateSubnetName string

@description('Public subnet name (delegated to Microsoft.Databricks/workspaces)')
param publicSubnetName string

@description('Boundary — controls UC availability')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Compliance tags')
param complianceTags object

@description('Disable public IP (recommended; required at IL4+)')
param disablePublicIp bool = true

@description('Customer-managed key for storage (IL5)')
param storageCmkKeyUri string = ''

var workspaceName = 'adb-loom-${domainName}-${location}'

// The MRG (managed resource group) name must be globally unique and
// stable across deploys; Databricks creates this RG for its DBFS,
// VMSS, NSG, NICs, etc.
var managedRgName = 'rg-mng-${workspaceName}-${uniqueString(resourceGroup().id)}'

var ucSupported = boundary == 'Commercial' || boundary == 'GCC'

resource workspace 'Microsoft.Databricks/workspaces@2024-09-01-preview' = {
  name: workspaceName
  location: location
  tags: complianceTags
  sku: { name: 'premium' }
  properties: {
    managedResourceGroupId: subscriptionResourceId('Microsoft.Resources/resourceGroups', managedRgName)
    parameters: {
      enableNoPublicIp: { value: disablePublicIp }
      customVirtualNetworkId: {
        value: resourceId('Microsoft.Network/virtualNetworks', spokeVnetName)
      }
      customPrivateSubnetName: { value: privateSubnetName }
      customPublicSubnetName: { value: publicSubnetName }
      requireInfrastructureEncryption: { value: true }
      prepareEncryption: { value: !empty(storageCmkKeyUri) }
    }
    publicNetworkAccess: 'Disabled'
    requiredNsgRules: 'NoAzureDatabricksRules'
  }
}

// Outputs the caller uses to bootstrap:
// - UC metastore wiring (if ucSupported)
// - SQL Warehouse provisioning (via Databricks REST API post-deploy)
// - Job + cluster definitions (deployed via dbx or asset bundles)

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: workspace
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'dbfs', enabled: true }
      { category: 'clusters', enabled: true }
      { category: 'accounts', enabled: true }
      { category: 'jobs', enabled: true }
      { category: 'notebook', enabled: true }
      { category: 'ssh', enabled: true }
      { category: 'workspace', enabled: true }
      { category: 'secrets', enabled: true }
      { category: 'sqlPermissions', enabled: true }
      { category: 'instancePools', enabled: true }
      { category: 'sqlanalytics', enabled: true }
      { category: 'genie', enabled: true }
      { category: 'globalInitScripts', enabled: true }
      { category: 'iamRole', enabled: true }
      { category: 'mlflowExperiment', enabled: true }
      { category: 'featureStore', enabled: true }
      { category: 'RemoteHistoryService', enabled: true }
      { category: 'modelRegistry', enabled: true }
      { category: 'repos', enabled: true }
      { category: 'unityCatalog', enabled: true }
      { category: 'gitCredentials', enabled: true }
    ]
  }
}

output workspaceId string = workspace.id
output workspaceUrl string = 'https://${workspace.properties.workspaceUrl}'
output workspaceName string = workspace.name
output ucSupported bool = ucSupported
output managedRgId string = workspace.properties.managedResourceGroupId
