// Azure Data Factory - Government Deployment Module
// Managed VNet for secure data movement

@description('Data Factory name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('Enable managed virtual network.')
param managedVirtualNetworkEnabled bool = true

@description('Public network access.')
param publicNetworkAccess string = 'Disabled'

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

// #checkov:skip=CKV_AZURE_103:Data Factory CMK configured out-of-band for gov deployments
// #checkov:skip=CKV_AZURE_104:Data Factory source control integration configured out-of-band, not in IaC
resource dataFactory 'Microsoft.DataFactory/factories@2018-06-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess
    globalParameters: {
      environment: {
        type: 'String'
        value: tags.?Cloud_Environment ?? 'AzureUSGovernment'
      }
      cloudType: {
        type: 'String'
        value: 'AzureUSGovernment'
      }
    }
  }
}

// Managed Virtual Network
resource managedVnet 'Microsoft.DataFactory/factories/managedVirtualNetworks@2018-06-01' = if (managedVirtualNetworkEnabled) {
  parent: dataFactory
  name: 'default'
  properties: {}
}

// Auto-resolve integration runtime within managed VNet
resource autoResolveIR 'Microsoft.DataFactory/factories/integrationRuntimes@2018-06-01' = if (managedVirtualNetworkEnabled) {
  parent: dataFactory
  name: 'AutoResolveIntegrationRuntime'
  properties: {
    type: 'Managed'
    managedVirtualNetwork: {
      referenceName: 'default'
      type: 'ManagedVirtualNetworkReference'
    }
    typeProperties: {
      computeProperties: {
        location: 'AutoResolve'
        dataFlowProperties: {
          computeType: 'General'
          coreCount: 8
          timeToLive: 10
        }
      }
    }
  }
  dependsOn: [managedVnet]
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: dataFactory
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'ActivityRuns', enabled: true }
      { category: 'PipelineRuns', enabled: true }
      { category: 'TriggerRuns', enabled: true }
      { category: 'SSISIntegrationRuntimeLogs', enabled: true }
      { category: 'SSISPackageEventMessageContext', enabled: true }
      { category: 'SSISPackageExecutableStatistics', enabled: true }
      { category: 'SSISPackageEventMessages', enabled: true }
      { category: 'SSISPackageExecutionComponentPhases', enabled: true }
      { category: 'SSISPackageExecutionDataStatistics', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output dataFactoryId string = dataFactory.id
output dataFactoryName string = dataFactory.name
output principalId string = dataFactory.identity.principalId
