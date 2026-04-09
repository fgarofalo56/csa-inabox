// Azure Monitor Workbook — Data Platform Health
// Provides at-a-glance visibility into pipeline health, data freshness, resource utilization, and costs.
targetScope = 'resourceGroup'

@description('Workbook display name')
param workbookName string = 'Data Platform Health'

@description('Location for the workbook resource')
param location string = resourceGroup().location

@description('Resource ID of the Log Analytics workspace')
param logAnalyticsWorkspaceId string

@description('Tags for the workbook')
param tags object = {}

// Workbook definition
var workbookContent = {
  version: 'Notebook/1.0'
  items: [
    // ─── Header ─────────────────────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '# Data Platform Health Dashboard\n---\nReal-time health monitoring for the CSA-in-a-Box data platform. Covers pipeline execution, data freshness, resource utilization, and cost trends.'
      }
      name: 'header'
    }
    // ─── Time Range Picker ──────────────────────────────────────────────────
    {
      type: 9
      content: {
        version: 'KqlParameterItem/1.0'
        parameters: [
          {
            id: 'timeRange'
            version: 'KqlParameterItem/1.0'
            name: 'TimeRange'
            type: 4
            isRequired: true
            value: {
              durationMs: 86400000
            }
            typeSettings: {
              selectableValues: [
                { durationMs: 3600000 }
                { durationMs: 14400000 }
                { durationMs: 43200000 }
                { durationMs: 86400000 }
                { durationMs: 259200000 }
                { durationMs: 604800000 }
              ]
            }
          }
        ]
      }
      name: 'parameters'
    }
    // ─── Pipeline Health Section ────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '## Pipeline Execution Summary'
      }
      name: 'pipelineHeader'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'ADFPipelineRun\n| where TimeGenerated >= ago(24h)\n| summarize\n    Total = count(),\n    Succeeded = countif(Status == "Succeeded"),\n    Failed = countif(Status == "Failed"),\n    InProgress = countif(Status == "InProgress"),\n    Cancelled = countif(Status == "Cancelled")\n| extend SuccessRate = round(todouble(Succeeded) / todouble(Total) * 100, 1)'
        size: 3
        title: 'ADF Pipeline Runs (Last 24h)'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'tiles'
        tileSettings: {
          titleContent: {
            columnMatch: 'Total'
            formatter: 1
          }
          showBorder: false
        }
      }
      name: 'pipelineSummary'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'ADFPipelineRun\n| where TimeGenerated >= ago(7d)\n| summarize\n    Runs = count(),\n    Failures = countif(Status == "Failed")\n    by bin(TimeGenerated, 1h)\n| render timechart'
        size: 0
        title: 'Pipeline Runs Over Time'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'timechart'
      }
      name: 'pipelineTimechart'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'ADFPipelineRun\n| where Status == "Failed" and TimeGenerated >= ago(24h)\n| project TimeGenerated, PipelineName, ErrorMessage = tostring(Output)\n| order by TimeGenerated desc\n| take 20'
        size: 0
        title: 'Recent Pipeline Failures'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'table'
      }
      name: 'pipelineFailures'
    }
    // ─── Databricks Section ─────────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '## Databricks Cluster Health'
      }
      name: 'databricksHeader'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'DatabricksJobs\n| where TimeGenerated >= ago(24h)\n| summarize\n    TotalJobs = count(),\n    SuccessJobs = countif(ActionName has "Succeeded" or ActionName has "completed"),\n    FailedJobs = countif(ActionName has "Failed" or ActionName has "error")\n| extend SuccessRate = iff(TotalJobs > 0, round(todouble(SuccessJobs) / todouble(TotalJobs) * 100, 1), 0.0)'
        size: 3
        title: 'Databricks Job Summary (Last 24h)'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'tiles'
      }
      name: 'databricksSummary'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'DatabricksClusters\n| where TimeGenerated >= ago(24h)\n| summarize arg_max(TimeGenerated, *) by ClusterId\n| project ClusterId, ClusterName = tostring(RequestParams.cluster_name), ActionName, TimeGenerated\n| order by TimeGenerated desc'
        size: 0
        title: 'Active Clusters'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'table'
      }
      name: 'databricksClusters'
    }
    // ─── Storage Section ────────────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '## Storage Health'
      }
      name: 'storageHeader'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'StorageBlobLogs\n| where TimeGenerated >= ago(24h)\n| summarize\n    TotalOps = count(),\n    ReadOps = countif(OperationName has "GetBlob"),\n    WriteOps = countif(OperationName has "PutBlob"),\n    Errors = countif(StatusCode >= 400)\n    by bin(TimeGenerated, 1h)\n| render timechart'
        size: 0
        title: 'Storage Operations Over Time'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'timechart'
      }
      name: 'storageOps'
    }
    // ─── Synapse Section ────────────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '## Synapse Analytics'
      }
      name: 'synapseHeader'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'SynapseSqlPoolExecRequests\n| where TimeGenerated >= ago(24h)\n| summarize\n    TotalQueries = count(),\n    AvgDurationMs = avg(EndTime - StartTime)\n    by bin(TimeGenerated, 1h)\n| render timechart'
        size: 0
        title: 'Synapse Query Volume'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'timechart'
      }
      name: 'synapseQueries'
    }
    // ─── Data Quality Section ───────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '## Data Quality Metrics'
      }
      name: 'qualityHeader'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'customMetrics\n| where name startswith "dq_"\n| where timestamp >= ago(7d)\n| summarize AvgValue = avg(value) by name, bin(timestamp, 1d)\n| render timechart'
        size: 0
        title: 'Data Quality Scores Over Time'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'timechart'
      }
      name: 'qualityMetrics'
    }
    // ─── Cost Section ───────────────────────────────────────────────────────
    {
      type: 1
      content: {
        json: '## Resource Utilization & Cost Indicators'
      }
      name: 'costHeader'
    }
    {
      type: 3
      content: {
        version: 'KqlItem/1.0'
        query: 'AzureMetrics\n| where TimeGenerated >= ago(7d)\n| where ResourceProvider in ("MICROSOFT.DATABRICKS", "MICROSOFT.SYNAPSE", "MICROSOFT.DATAFACTORY", "MICROSOFT.KUSTO", "MICROSOFT.STORAGE")\n| summarize AvgValue = avg(Average) by ResourceProvider, MetricName, bin(TimeGenerated, 1d)\n| order by ResourceProvider, MetricName, TimeGenerated'
        size: 0
        title: 'Resource Metrics by Provider'
        queryType: 0
        resourceType: 'microsoft.operationalinsights/workspaces'
        visualization: 'table'
      }
      name: 'resourceMetrics'
    }
  ]
  isLocked: false
}

// Resources
resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(resourceGroup().id, workbookName)
  location: location
  tags: tags
  kind: 'shared'
  properties: {
    category: 'workbook'
    displayName: workbookName
    serializedData: string(workbookContent)
    sourceId: logAnalyticsWorkspaceId
  }
}

// Outputs
output workbookId string = workbook.id
output workbookName string = workbook.properties.displayName
