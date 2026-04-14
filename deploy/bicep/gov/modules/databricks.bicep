// Azure Databricks Workspace - Government Deployment Module
// Premium tier for Unity Catalog, SCIM, and customer-managed keys

@description('Workspace name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@allowed(['standard', 'premium'])
@description('Pricing tier (premium required for Unity Catalog).')
param pricingTier string = 'premium'

@description('Enable no public IP for secure cluster connectivity.')
param enableNoPublicIp bool = true

@description('Require infrastructure encryption (double encryption).')
param requireInfrastructureEncryption bool = true

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

resource databricks 'Microsoft.Databricks/workspaces@2024-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: pricingTier
  }
  properties: {
    managedResourceGroupId: subscriptionResourceId(
      'Microsoft.Resources/resourceGroups',
      'rg-${name}-managed'
    )
    publicNetworkAccess: 'Disabled'
    requiredNsgRules: 'NoAzureDatabricksRules'
    parameters: {
      enableNoPublicIp: {
        value: enableNoPublicIp
      }
      requireInfrastructureEncryption: {
        value: requireInfrastructureEncryption
      }
      prepareEncryption: {
        value: true
      }
    }
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: databricks
  properties: {
    workspaceId: logAnalyticsId
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
      { category: 'unityCatalog', enabled: true }
    ]
  }
}

output workspaceId string = databricks.id
output workspaceName string = databricks.name
output workspaceUrl string = databricks.properties.workspaceUrl
