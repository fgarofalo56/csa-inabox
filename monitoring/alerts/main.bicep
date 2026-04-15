// ─────────────────────────────────────────────────────────────
// Main Alerts Module — Orchestrates All Operational Alerts
// CSA-in-a-Box Monitoring
//
// Deploys all operational alerts for the CSA data platform:
// pipelines, Databricks, storage, Key Vault, and data quality.
// ─────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID for all alert scoping')
param logAnalyticsWorkspaceId string

@description('Action group resource ID for alert notifications')
param actionGroupId string

@description('Environment identifier')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for alert rule resources')
param location string = resourceGroup().location

@description('Array of storage account resource IDs to monitor (optional)')
param storageAccountIds array = []

@description('Array of Key Vault resource IDs to monitor (optional)')
param keyVaultIds array = []

// ─── Pipeline Alert Thresholds ──────────────────────────────
@description('Pipeline duration SLA threshold in minutes')
param pipelineDurationThresholdMinutes int = environment == 'prod' ? 60 : 120

// ─── Databricks Alert Thresholds ────────────────────────────
@description('Databricks job timeout threshold in minutes')
param databricksJobTimeoutMinutes int = environment == 'prod' ? 120 : 240

@description('Databricks cluster CPU utilization threshold percentage')
param databricksClusterCpuThreshold int = environment == 'prod' ? 85 : 95

// ─── Storage Alert Thresholds ───────────────────────────────
@description('Storage availability threshold (multiplied by 10, e.g., 999 = 99.9%)')
param storageAvailabilityThreshold int = environment == 'prod' ? 999 : 995

@description('Storage E2E latency threshold in milliseconds')
param storageLatencyThresholdMs int = environment == 'prod' ? 500 : 1000

@description('Storage capacity threshold in bytes')
param storageCapacityThresholdBytes int = environment == 'prod' ? 4398046511104 : 5497558138880

// ─── Key Vault Alert Thresholds ─────────────────────────────
@description('Key Vault secret/certificate expiry warning in days')
param keyVaultExpiryWarningDays int = environment == 'prod' ? 30 : 14

@description('Key Vault unauthorized access attempt threshold')
param keyVaultUnauthorizedThreshold int = environment == 'prod' ? 3 : 10

// ─── Data Quality Alert Thresholds ──────────────────────────
@description('Data freshness SLA threshold in hours')
param dataFreshnessSlaHours int = environment == 'prod' ? 2 : 6

@description('Minimum quality rule violations to trigger alert')
param dataQualityViolationThreshold int = environment == 'prod' ? 1 : 5

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  Environment: environment
}

// ─── Pipeline Alerts ────────────────────────────────────────
module pipelineAlerts 'pipeline-alerts.bicep' = {
  name: 'deploy-pipeline-alerts-${environment}'
  params: {
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    actionGroupId: actionGroupId
    environment: environment
    location: location
    pipelineDurationThresholdMinutes: pipelineDurationThresholdMinutes
    tags: tags
  }
}

// ─── Databricks Alerts ──────────────────────────────────────
module databricksAlerts 'databricks-alerts.bicep' = {
  name: 'deploy-databricks-alerts-${environment}'
  params: {
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    actionGroupId: actionGroupId
    environment: environment
    location: location
    jobTimeoutThresholdMinutes: databricksJobTimeoutMinutes
    clusterCpuThresholdPercent: databricksClusterCpuThreshold
    tags: tags
  }
}

// ─── Storage Alerts (conditional) ───────────────────────────
module storageAlerts 'storage-alerts.bicep' = if (!empty(storageAccountIds)) {
  name: 'deploy-storage-alerts-${environment}'
  params: {
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    actionGroupId: actionGroupId
    environment: environment
    location: location
    storageAccountIds: storageAccountIds
    availabilityThreshold: storageAvailabilityThreshold
    latencyThresholdMs: storageLatencyThresholdMs
    capacityThresholdBytes: storageCapacityThresholdBytes
    tags: tags
  }
}

// ─── Key Vault Alerts (conditional) ─────────────────────────
module keyVaultAlerts 'keyvault-alerts.bicep' = if (!empty(keyVaultIds)) {
  name: 'deploy-keyvault-alerts-${environment}'
  params: {
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    actionGroupId: actionGroupId
    environment: environment
    location: location
    keyVaultIds: keyVaultIds
    expiryWarningDays: keyVaultExpiryWarningDays
    unauthorizedAccessThreshold: keyVaultUnauthorizedThreshold
    availabilityThresholdTenths: environment == 'prod' ? 999 : 995
    tags: tags
  }
}

// ─── Data Quality Alerts ────────────────────────────────────
module dataQualityAlerts 'data-quality-alerts.bicep' = {
  name: 'deploy-data-quality-alerts-${environment}'
  params: {
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    actionGroupId: actionGroupId
    environment: environment
    location: location
    dataFreshnessSlaHours: dataFreshnessSlaHours
    qualityViolationThreshold: dataQualityViolationThreshold
    tags: tags
  }
}

// ─── Outputs ─────────────────────────────────────────────────
output pipelineAlertIds object = {
  pipelineFailure: pipelineAlerts.outputs.pipelineFailureAlertId
  pipelineDuration: pipelineAlerts.outputs.pipelineDurationAlertId
  activityFailure: pipelineAlerts.outputs.activityFailureAlertId
}

output databricksAlertIds object = {
  jobFailure: databricksAlerts.outputs.jobFailureAlertId
  clusterUtilization: databricksAlerts.outputs.clusterUtilizationAlertId
  jobTimeout: databricksAlerts.outputs.jobTimeoutAlertId
}

output dataQualityAlertIds object = {
  qualityViolation: dataQualityAlerts.outputs.qualityViolationAlertId
  freshness: dataQualityAlerts.outputs.freshnessAlertId
  schemaDrift: dataQualityAlerts.outputs.schemaDriftAlertId
}
