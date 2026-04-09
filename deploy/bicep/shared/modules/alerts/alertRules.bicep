// Alert Rules for Data Platform Infrastructure
// Monitors critical services and triggers notifications

targetScope = 'resourceGroup'

@description('Location')
param location string = resourceGroup().location

@description('Log Analytics workspace resource ID')
param logAnalyticsWorkspaceId string

@description('Action group resource ID for notifications')
param actionGroupId string

@description('Environment (dev/prod)')
param environment string = 'dev'

@description('Tags')
param tags object = {}

// ADF Pipeline Failure Alert
resource adfPipelineFailure 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'csa-alert-adf-pipeline-failure-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'ADF Pipeline Failure'
    description: 'Alert when an ADF pipeline run fails'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where ResourceProvider == "MICROSOFT.DATAFACTORY"
            | where Category == "PipelineRuns"
            | where status_s == "Failed"
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupId]
    }
  }
}

// Databricks Cluster Failure
resource databricksClusterFailure 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'csa-alert-dbx-cluster-failure-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Databricks Cluster Failure'
    description: 'Alert when a Databricks cluster fails to start or terminates unexpectedly'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where ResourceProvider == "MICROSOFT.DATABRICKS"
            | where Category == "clusters"
            | where actionName_s in ("terminateCluster", "startClusterResult")
            | where statusCode_s != "200"
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupId]
    }
  }
}

// Storage Capacity Warning (> 80%)
resource storageCapacityWarning 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'csa-alert-storage-capacity-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Storage Capacity Warning'
    description: 'Alert when storage account usage exceeds 80% of capacity'
    severity: 3
    enabled: true
    evaluationFrequency: 'PT1H'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            AzureMetrics
            | where ResourceProvider == "MICROSOFT.STORAGE"
            | where MetricName == "UsedCapacity"
            | summarize MaxUsedGB = max(Maximum) / 1073741824 by Resource
            | where MaxUsedGB > 4000
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupId]
    }
  }
}

// Function App Execution Errors
resource functionErrors 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'csa-alert-function-errors-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Azure Function Execution Errors'
    description: 'Alert on high rate of function execution failures'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            FunctionAppLogs
            | where Level == "Error" or Level == "Critical"
            | summarize ErrorCount = count() by FunctionName
            | where ErrorCount > 5
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupId]
    }
  }
}

// Firewall Denied Traffic Spike
resource firewallDeniedSpike 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'csa-alert-firewall-denied-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Firewall Denied Traffic Spike'
    description: 'Alert when denied network traffic exceeds normal threshold'
    severity: 3
    enabled: true
    evaluationFrequency: 'PT15M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where ResourceProvider == "MICROSOFT.NETWORK"
            | where Category == "AzureFirewallNetworkRule" or Category == "AzureFirewallApplicationRule"
            | where msg_s has "Deny"
            | summarize DeniedCount = count() by bin(TimeGenerated, 15m)
            | where DeniedCount > 100
          '''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 2
            minFailingPeriodsToAlert: 2
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupId]
    }
  }
}
