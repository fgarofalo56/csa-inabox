// Azure OpenAI - Government Deployment Module
// AI services for data enrichment and analysis

@description('Cognitive Services account name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('SKU name.')
param sku string = 'S0'

@description('Public network access.')
param publicNetworkAccess string = 'Disabled'

@description('Model deployments.')
param deployments array = []

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

// #checkov:skip=CKV_AZURE_236:OpenAI CMK configured out-of-band for gov deployments
resource openAI 'Microsoft.CognitiveServices/accounts@2024-04-01-preview' = {
  name: name
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: sku
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess
    disableLocalAuth: true  // Force Entra ID auth
    networkAcls: {
      defaultAction: 'Deny'
    }
    customSubDomainName: name
  }
}

// Model deployments
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2024-04-01-preview' = [
  for deployment in deployments: {
    parent: openAI
    name: deployment.name
    sku: {
      name: 'Standard'
      capacity: deployment.capacity
    }
    properties: {
      model: {
        format: 'OpenAI'
        name: deployment.model
        version: deployment.version
      }
      raiPolicyName: 'Microsoft.Default'
    }
  }
]

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: openAI
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'Audit', enabled: true }
      { category: 'RequestResponse', enabled: true }
      { category: 'Trace', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output accountId string = openAI.id
output accountName string = openAI.name
output endpoint string = openAI.properties.endpoint
output principalId string = openAI.identity.principalId
