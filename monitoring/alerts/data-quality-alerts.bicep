// ─────────────────────────────────────────────────────────────
// Data Quality Alerts — Data Platform Quality Monitoring
// CSA-in-a-Box Monitoring
//
// Deploys scheduled query rules for data quality rule violations,
// data freshness SLA breaches, and schema drift detection
// via custom logs in Log Analytics.
// ─────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID for data quality monitoring')
param logAnalyticsWorkspaceId string

@description('Action group resource ID for alert notifications')
param actionGroupId string

@description('Environment identifier')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for alert rule resources')
param location string = resourceGroup().location

@description('Data freshness SLA threshold in hours — alert if no new data within this window')
param dataFreshnessSlaHours int = environment == 'prod' ? 2 : 6

@description('Minimum quality rule violations to trigger alert')
#disable-next-line no-unused-params // Used in KQL query string interpolation
param qualityViolationThreshold int = environment == 'prod' ? 1 : 5

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  AlertDomain: 'DataQuality'
  Environment: environment
}

// ─── Data Quality Rule Violation Alert ──────────────────────
resource dataQualityViolationAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-data-quality-violation-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Data Quality Rule Violation'
    description: 'Triggers when data quality check failures are detected in the pipeline'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT15M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            CustomLogs_DataQuality_CL
            | where CheckResult_s == 'FAIL' or CheckResult_s == 'ERROR'
            | summarize ViolationCount = count()
                by RuleName_s, DatasetName_s, CheckType_s, bin(TimeGenerated, 15m)
            | where ViolationCount >= ${qualityViolationThreshold}
            | project RuleName_s, DatasetName_s, CheckType_s, ViolationCount, TimeGenerated
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

// ─── Data Freshness SLA Breach Alert ────────────────────────
resource dataFreshnessAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-data-freshness-sla-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Data Freshness SLA Breach'
    description: 'Triggers when no new data has been ingested within the expected ${dataFreshnessSlaHours}-hour window'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT30M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT1H'
    criteria: {
      allOf: [
        {
          query: '''
            CustomLogs_DataIngestion_CL
            | summarize LastIngestion = max(TimeGenerated) by DatasetName_s, PipelineName_s
            | where LastIngestion < ago(${dataFreshnessSlaHours}h)
            | extend HoursSinceLastIngestion = datetime_diff('hour', now(), LastIngestion)
            | project DatasetName_s, PipelineName_s, LastIngestion, HoursSinceLastIngestion
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

// ─── Schema Drift Detection Alert ───────────────────────────
resource schemaDriftAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-schema-drift-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Schema Drift Detected'
    description: 'Triggers when schema changes are detected in incoming data that deviate from the expected schema'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            CustomLogs_SchemaDrift_CL
            | where DriftDetected_b == true
            | extend ColumnsAdded = toint(ColumnsAdded_d)
            | extend ColumnsRemoved = toint(ColumnsRemoved_d)
            | extend TypeChanges = toint(TypeChanges_d)
            | project DatasetName_s, ColumnsAdded, ColumnsRemoved, TypeChanges,
                      DriftDetails_s, TimeGenerated
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
output qualityViolationAlertId string = dataQualityViolationAlert.id
output freshnessAlertId string = dataFreshnessAlert.id
output schemaDriftAlertId string = schemaDriftAlert.id
