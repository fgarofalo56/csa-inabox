targetScope = 'managementGroup'

metadata name = 'ALZ Bicep - Management Group Diagnostic Settings'
metadata description = 'Module used to set up Diagnostic Settings for Management Groups'

@sys.description('Log Analytics Workspace Resource ID.')
param parLogAnalyticsWorkspaceResourceId string

@sys.description('Diagnostic Settings Name.')
param parDiagnosticSettingsName string = 'toLa'

@sys.description('Set Parameter to true to Opt-out of deployment telemetry')
param parTelemetryOptOut bool = false

// Customer Usage Attribution Id
var varCuaid = '5d17f1c2-f17b-4426-9712-0cd2652c4435'

resource mgDiagSet 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: parDiagnosticSettingsName
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
    ]
  }
}

param diagnosticSettingsName string = 'default'
param workspaceId string
param logAnalyticsDestinationEnabled bool = true

resource diagnosticSettings 'Microsoft.Insights/diagnosticSettings@2017-05-01-preview' = {
  name: 'diagnosticSettings-${diagnosticSettingsName}'
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'AllLogs'
        enabled: logAnalyticsDestinationEnabled
      }
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

    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
      {
        category: 'Capacity'
        enabled: true
      }
      {
        category: 'DataIngestion'
        enabled: true
      }
      {
        category: 'DataRetention'
        enabled: true
      }
      {
        category: 'DataStorage'
        enabled: true
      }
      {
        category: 'IngestionRate'
        enabled: true
      }
      {
        category: 'Query'
        enabled: true
      }
      {
        category: 'Retention'
        enabled: true
      }
      {
        category: 'ServiceHealth'
        enabled: true
      }
    {
        category: 'Usage'
        enabled: true
      }
      {
        category: 'Workspaces'
        enabled: true
      }
      {
        category: 'WorkspacesQuota'
        enabled: true
      }
    ]
  }
}

output diagnosticSettingsName string = diagnosticSettingsName
