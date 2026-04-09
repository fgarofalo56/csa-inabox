// Stream Analytics Module
// Deploys Stream Analytics job for real-time data processing
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Stream Analytics job.')
param jobName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('SKU name.')
@allowed([
  'Standard'
])
param sku string = 'Standard'

@description('Number of streaming units (1, 3, 6, 12, 18, 24, 30, 36, 42, 48).')
@allowed([
  1
  3
  6
  12
  18
  24
  30
  36
  42
  48
])
param streamingUnits int = 3

@description('Compatibility level.')
@allowed([
  '1.0'
  '1.1'
  '1.2'
])
param compatibilityLevel string = '1.2'

@description('Content storage policy.')
@allowed([
  'SystemAccount'
  'JobStorageAccount'
])
param contentStoragePolicy string = 'SystemAccount'

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

// Resources
resource streamAnalyticsJob 'Microsoft.StreamAnalytics/streamingjobs@2021-10-01-preview' = {
  name: jobName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    sku: {
      name: sku
    }
    eventsOutOfOrderPolicy: 'Adjust'
    eventsOutOfOrderMaxDelayInSeconds: 5
    eventsLateArrivalMaxDelayInSeconds: 16
    outputErrorPolicy: 'Stop'
    dataLocale: 'en-US'
    compatibilityLevel: compatibilityLevel
    contentStoragePolicy: contentStoragePolicy
    transformation: {
      name: 'Transformation'
      properties: {
        streamingUnits: streamingUnits
        query: 'SELECT * INTO [output] FROM [input]'
      }
    }
  }
}

// Diagnostic Settings
resource streamAnalyticsDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${jobName}-diagnostics'
  scope: streamAnalyticsJob
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'Execution'; enabled: true }
      { category: 'Authoring'; enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics'; enabled: true }
    ]
  }
}

// Outputs
@description('Resource ID of the Stream Analytics job.')
output jobId string = streamAnalyticsJob.id

@description('Name of the Stream Analytics job.')
output jobName string = streamAnalyticsJob.name

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = streamAnalyticsJob.identity.principalId
