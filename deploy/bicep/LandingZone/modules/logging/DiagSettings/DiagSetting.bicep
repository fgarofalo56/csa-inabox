
targetScope = 'subscription'

metadata name = 'ALZ Bicep - Diagnostic Settings'
metadata description = 'Module used to set up Diagnostic Settings'

@sys.description('Log Analytics Workspace Resource ID.')
param parLogAnalyticsWorkspaceResourceId string

@sys.description('Diagnostic Settings Name.')
param parDiagnosticSettingsName string = 'dataObservability'

param prefix string
param environment string



resource DiagSet 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: '${prefix}-${parDiagnosticSettingsName}-${environment}-diagSettingsLA'
  properties: {
    workspaceId: parLogAnalyticsWorkspaceResourceId
    logs: [
      {
        category: 'Administrative'
        enabled: true
      }
      {
        category: 'Policy'
        enabled: true
      }
      {
        category: 'Security'
        enabled: true
      }
      {
        category: 'ServiceHealth'
        enabled: true
      }
      {
        category: 'ResourceHealth'
        enabled: true
      }
      {
        category: 'Alert'
        enabled: true
      }
      {
        category: 'Autoscale'
        enabled: true
      }
      {
        category: 'Recommendation'
        enabled: true
      }
    ]
  }
}

// resource DiagSetCategory'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
//   name: '${prefix}-${parDiagnosticSettingsName}-${environment}-diagSettingsLA'
//   properties: {
//     workspaceId: parLogAnalyticsWorkspaceResourceId
//     logs: [
//       {
//         categoryGroup: 'allLogs'
//         enabled: true
//       }
//     ]
//   }
// }


output DiagSet string = DiagSet.name
