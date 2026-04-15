// Azure Machine Learning - Government Deployment Module
// ML lifecycle management

@description('Workspace name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('Key Vault resource ID.')
param keyVaultId string

@description('Storage account resource ID.')
param storageAccountId string

@description('Application Insights resource ID.')
param applicationInsightsId string = ''

@description('Public network access.')
param publicNetworkAccess string = 'Disabled'

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

resource mlWorkspace 'Microsoft.MachineLearningServices/workspaces@2024-04-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  properties: {
    friendlyName: name
    keyVault: keyVaultId
    storageAccount: storageAccountId
    applicationInsights: !empty(applicationInsightsId) ? applicationInsightsId : null
    publicNetworkAccess: publicNetworkAccess
    v1LegacyMode: false
    encryption: {
      status: 'Enabled'
      keyVaultProperties: {
        keyVaultArmId: keyVaultId
      }
    }
    managedNetwork: {
      isolationMode: 'AllowInternetOutbound'
    }
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: mlWorkspace
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'AmlComputeClusterEvent', enabled: true }
      { category: 'AmlComputeClusterNodeEvent', enabled: true }
      { category: 'AmlComputeJobEvent', enabled: true }
      { category: 'AmlComputeCpuGpuUtilization', enabled: true }
      { category: 'AmlRunStatusChangedEvent', enabled: true }
      { category: 'ModelsChangeEvent', enabled: true }
      { category: 'ModelsReadEvent', enabled: true }
      { category: 'ModelsActionEvent', enabled: true }
      { category: 'DeploymentReadEvent', enabled: true }
      { category: 'DeploymentEventACI', enabled: true }
      { category: 'DeploymentEventAKS', enabled: true }
      { category: 'InferencingOperationAKS', enabled: true }
      { category: 'EnvironmentChangeEvent', enabled: true }
      { category: 'EnvironmentReadEvent', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output workspaceId string = mlWorkspace.id
output workspaceName string = mlWorkspace.name
output principalId string = mlWorkspace.identity.principalId
