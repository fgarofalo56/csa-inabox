// Shared module: Diagnostic Settings
// Reusable across all service modules for consistent logging/metrics
targetScope = 'resourceGroup'

// Parameters
@description('Name for the diagnostic setting.')
param name string

@description('Resource ID of the target resource to monitor.')
param resourceId string

@description('Resource ID of the Log Analytics workspace to send diagnostics to.')
param logAnalyticsWorkspaceId string

@description('Log categories to enable. Each object: { category: string, enabled: bool }')
param logs array = []

@description('Metric categories to enable. Each object: { category: string, enabled: bool }')
param metrics array = [
  {
    category: 'AllMetrics'
    enabled: true
  }
]

@description('Retention policy in days. 0 = infinite.')
param retentionDays int = 90

// Resources
resource diagnosticSetting 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: name
  scope: existingResource
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      for log in logs: {
        category: log.category
        enabled: log.enabled
        retentionPolicy: {
          enabled: retentionDays > 0
          days: retentionDays
        }
      }
    ]
    metrics: [
      for metric in metrics: {
        category: metric.category
        enabled: metric.enabled
        retentionPolicy: {
          enabled: retentionDays > 0
          days: retentionDays
        }
      }
    ]
  }
}

// Note: The parent resource must be passed via scope.
// This module is designed to be used with the 'scope' keyword in the calling template:
//   module diagSettings 'shared/modules/diagnosticSettings.bicep' = {
//     name: 'diag-${resourceName}'
//     params: { ... }
//     scope: resourceGroup(...)
//   }
// The existingResource reference should be replaced with scope in the caller.

resource existingResource 'Microsoft.Resources/deployments@2021-04-01' existing = {
  name: 'placeholder'
}
