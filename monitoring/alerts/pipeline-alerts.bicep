// ─────────────────────────────────────────────────────────────
// Pipeline Alerts — ADF Pipeline Monitoring
// CSA-in-a-Box Monitoring
//
// Deploys scheduled query rules to detect ADF pipeline failures,
// SLA breaches, and activity-level errors via Log Analytics.
// ─────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID for pipeline monitoring')
param logAnalyticsWorkspaceId string

@description('Action group resource ID for alert notifications')
param actionGroupId string

@description('Environment identifier')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for alert rule resources')
param location string = resourceGroup().location

@description('Pipeline duration SLA threshold in minutes')
param pipelineDurationThresholdMinutes int = environment == 'prod' ? 60 : 120

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  AlertDomain: 'Pipeline'
  Environment: environment
}

// ─── ADF Pipeline Failure Alert ─────────────────────────────
resource adfPipelineFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-adf-pipeline-failure-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'ADF Pipeline Failure'
    description: 'Triggers when an ADF pipeline run fails'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: '''
            ADFPipelineRun
            | where Status == 'Failed'
            | summarize FailureCount = count() by PipelineName, bin(TimeGenerated, 5m)
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

// ─── ADF Pipeline Duration Alert (SLA Breach) ───────────────
resource adfPipelineDurationAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-adf-pipeline-duration-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'ADF Pipeline Duration SLA Breach'
    description: 'Triggers when pipeline execution exceeds SLA threshold of ${pipelineDurationThresholdMinutes} minutes'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ADFPipelineRun
            | where Status == 'Succeeded'
            | extend DurationMinutes = datetime_diff('minute', End, Start)
            | where DurationMinutes > ${pipelineDurationThresholdMinutes}
            | project PipelineName, DurationMinutes, Start, End
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

// ─── ADF Activity Failure Alert ─────────────────────────────
resource adfActivityFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-adf-activity-failure-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'ADF Activity Failure'
    description: 'Triggers when individual ADF activities fail repeatedly'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            ADFActivityRun
            | where Status == 'Failed'
            | summarize FailureCount = count() by ActivityName, PipelineName, bin(TimeGenerated, 15m)
            | where FailureCount >= 3
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
output pipelineFailureAlertId string = adfPipelineFailureAlert.id
output pipelineDurationAlertId string = adfPipelineDurationAlert.id
output activityFailureAlertId string = adfActivityFailureAlert.id
