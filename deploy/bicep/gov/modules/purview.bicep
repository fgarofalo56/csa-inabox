// Microsoft Purview - Government Deployment Module
// Data governance and cataloging

@description('Purview account name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('Public network access.')
param publicNetworkAccess string = 'Disabled'

@description('Managed resource group name.')
param managedResourceGroupName string = ''

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

resource purview 'Microsoft.Purview/accounts@2021-12-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess
    managedResourceGroupName: !empty(managedResourceGroupName) ? managedResourceGroupName : 'rg-${name}-managed'
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: purview
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'ScanStatusLogEvent', enabled: true }
      { category: 'DataSensitivity', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output accountId string = purview.id
output accountName string = purview.name
output principalId string = purview.identity.principalId
output catalogEndpoint string = purview.properties.endpoints.catalog
output scanEndpoint string = purview.properties.endpoints.scan
