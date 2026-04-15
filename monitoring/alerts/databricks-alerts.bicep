// ─────────────────────────────────────────────────────────────
// Databricks Alerts — Cluster and Job Monitoring
// CSA-in-a-Box Monitoring
//
// Deploys scheduled query rules to detect Databricks cluster
// failures, high utilization, and job timeouts via Log Analytics.
// ─────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID for Databricks monitoring')
param logAnalyticsWorkspaceId string

@description('Action group resource ID for alert notifications')
param actionGroupId string

@description('Environment identifier')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for alert rule resources')
param location string = resourceGroup().location

@description('Job timeout threshold in minutes')
param jobTimeoutThresholdMinutes int = environment == 'prod' ? 120 : 240

@description('Cluster CPU utilization threshold percentage')
param clusterCpuThresholdPercent int = environment == 'prod' ? 85 : 95

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  AlertDomain: 'Databricks'
  Environment: environment
}

// ─── Databricks Job Failure Alert ───────────────────────────
resource databricksJobFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-databricks-job-failure-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Databricks Job Failure'
    description: 'Triggers when a Databricks job run fails or is terminated unexpectedly'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            DatabricksJobs
            | where ActionName == 'runFailed' or ActionName == 'runTerminated'
            | extend JobId = tostring(RequestParams.jobId)
            | extend RunId = tostring(RequestParams.runId)
            | summarize FailureCount = count() by JobId, bin(TimeGenerated, 5m)
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

// ─── Databricks Cluster High Utilization Alert ──────────────
resource databricksClusterUtilizationAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-databricks-cluster-utilization-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Databricks Cluster High Utilization'
    description: 'Triggers when Databricks cluster CPU utilization exceeds ${clusterCpuThresholdPercent}% sustained over 15 minutes'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: '''
            DatabricksClusters
            | where ActionName == 'resizeCluster' or ActionName == 'createCluster'
            | extend ClusterId = tostring(RequestParams.clusterId)
            | join kind=inner (
                InsightsMetrics
                | where Namespace == 'databricks' and Name == 'cpu_percent'
                | where Val > ${clusterCpuThresholdPercent}
                | summarize AvgCpu = avg(Val) by ClusterId = tostring(Tags.clusterId), bin(TimeGenerated, 15m)
            ) on ClusterId
            | project ClusterId, AvgCpu, TimeGenerated
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

// ─── Databricks Job Timeout Alert ───────────────────────────
resource databricksJobTimeoutAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-databricks-job-timeout-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Databricks Job Timeout'
    description: 'Triggers when a Databricks job exceeds the expected duration threshold of ${jobTimeoutThresholdMinutes} minutes'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: '''
            DatabricksJobs
            | where ActionName == 'runStart'
            | extend JobId = tostring(RequestParams.jobId)
            | extend RunId = tostring(RequestParams.runId)
            | extend StartTime = TimeGenerated
            | join kind=leftanti (
                DatabricksJobs
                | where ActionName in ('runSucceeded', 'runFailed', 'runTerminated')
                | extend RunId = tostring(RequestParams.runId)
            ) on RunId
            | where datetime_diff('minute', now(), StartTime) > ${jobTimeoutThresholdMinutes}
            | project JobId, RunId, StartTime, RunningMinutes = datetime_diff('minute', now(), StartTime)
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

// ─── Outputs ─────────────────────────────────────────────────
output jobFailureAlertId string = databricksJobFailureAlert.id
output clusterUtilizationAlertId string = databricksClusterUtilizationAlert.id
output jobTimeoutAlertId string = databricksJobTimeoutAlert.id
