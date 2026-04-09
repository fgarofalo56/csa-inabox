// Azure Dashboard — Data Platform Overview
// Provides at-a-glance view of platform health, pipeline status, and costs

targetScope = 'resourceGroup'

@description('Dashboard name')
param dashboardName string = 'csa-platform-dashboard'

@description('Location for the dashboard resource')
param location string = resourceGroup().location

@description('Log Analytics workspace resource ID')
param logAnalyticsWorkspaceId string

@description('Tags for the dashboard')
param tags object = {}

resource dashboard 'Microsoft.Portal/dashboards@2020-09-01-preview' = {
  name: dashboardName
  location: location
  tags: union(tags, {
    'hidden-title': 'CSA-in-a-Box Platform Dashboard'
  })
  properties: {
    lenses: [
      {
        order: 0
        parts: [
          // Part 1: Platform Health Overview
          {
            position: { x: 0, y: 0, colSpan: 6, rowSpan: 4 }
            metadata: {
              type: 'Extension/HubsExtension/PartType/MarkdownPart'
              inputs: []
              settings: {
                content: {
                  settings: {
                    content: '## CSA-in-a-Box Platform Health\n\n| Component | Status |\n|-----------|--------|\n| Networking | Connected |\n| Storage | Active |\n| Compute | Available |\n| Governance | Scanning |\n\n*Auto-refreshes every 5 minutes*'
                    title: 'Platform Overview'
                    subtitle: 'CSA-in-a-Box'
                  }
                }
              }
            }
          }
          // Part 2: Resource Health
          {
            position: { x: 6, y: 0, colSpan: 6, rowSpan: 4 }
            metadata: {
              type: 'Extension/Microsoft_Azure_Monitoring/PartType/LogsDashboardPart'
              inputs: [
                {
                  name: 'resourceTypeMode'
                  isOptional: true
                }
                {
                  name: 'ComponentId'
                  isOptional: true
                  value: logAnalyticsWorkspaceId
                }
              ]
              settings: {
                content: {
                  Query: 'AzureActivity\n| where TimeGenerated > ago(24h)\n| where OperationNameValue has "Microsoft.Resources/deployments"\n| summarize Count=count() by OperationNameValue, ActivityStatusValue\n| order by Count desc\n| take 10'
                  ControlType: 'AnalyticsGrid'
                  SpecificChart: ''
                  Dimensions: {}
                }
              }
            }
          }
          // Part 3: Pipeline Failures (last 24h)
          {
            position: { x: 0, y: 4, colSpan: 6, rowSpan: 4 }
            metadata: {
              type: 'Extension/Microsoft_Azure_Monitoring/PartType/LogsDashboardPart'
              inputs: [
                {
                  name: 'ComponentId'
                  isOptional: true
                  value: logAnalyticsWorkspaceId
                }
              ]
              settings: {
                content: {
                  Query: 'AzureDiagnostics\n| where ResourceProvider == "MICROSOFT.DATAFACTORY"\n| where Category == "PipelineRuns"\n| where TimeGenerated > ago(24h)\n| summarize Total=count(), Failed=countif(status_s == "Failed"), Succeeded=countif(status_s == "Succeeded") by pipelineName_s\n| order by Failed desc'
                  ControlType: 'AnalyticsGrid'
                  SpecificChart: ''
                }
              }
            }
          }
          // Part 4: Storage Usage Trend
          {
            position: { x: 6, y: 4, colSpan: 6, rowSpan: 4 }
            metadata: {
              type: 'Extension/Microsoft_Azure_Monitoring/PartType/LogsDashboardPart'
              inputs: [
                {
                  name: 'ComponentId'
                  isOptional: true
                  value: logAnalyticsWorkspaceId
                }
              ]
              settings: {
                content: {
                  Query: 'AzureMetrics\n| where ResourceProvider == "MICROSOFT.STORAGE"\n| where MetricName == "UsedCapacity"\n| summarize AvgCapacityGB=avg(Average)/1073741824 by bin(TimeGenerated, 1h), Resource\n| render timechart'
                  ControlType: 'FrameControlChart'
                  SpecificChart: 'Line'
                }
              }
            }
          }
          // Part 5: Security Alerts
          {
            position: { x: 0, y: 8, colSpan: 12, rowSpan: 4 }
            metadata: {
              type: 'Extension/Microsoft_Azure_Monitoring/PartType/LogsDashboardPart'
              inputs: [
                {
                  name: 'ComponentId'
                  isOptional: true
                  value: logAnalyticsWorkspaceId
                }
              ]
              settings: {
                content: {
                  Query: 'SecurityAlert\n| where TimeGenerated > ago(7d)\n| summarize Count=count() by AlertName, AlertSeverity, ProviderName\n| order by Count desc\n| take 20'
                  ControlType: 'AnalyticsGrid'
                  SpecificChart: ''
                }
              }
            }
          }
        ]
      }
    ]
  }
}

output dashboardId string = dashboard.id
