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

output workspaceId string = workspace.id
output workspaceUrl string = 'https://${workspace.properties.workspaceUrl}'
output workspaceName string = workspace.name
output ucSupported bool = ucSupported
output managedRgId string = workspace.properties.managedResourceGroupId
