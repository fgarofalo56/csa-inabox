// ─────────────────────────────────────────────────────────────
// Storage Alerts — Azure Storage Account Monitoring
// CSA-in-a-Box Monitoring
//
// Deploys metric alerts for storage account availability,
// latency, and capacity thresholds via Azure Monitor.
// ─────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID (accepted for interface consistency)')
#disable-next-line no-unused-params
param logAnalyticsWorkspaceId string

@description('Action group resource ID for alert notifications')
param actionGroupId string

@description('Environment identifier')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for alert rule resources (accepted for interface consistency)')
#disable-next-line no-unused-params
param location string = resourceGroup().location

@description('Array of storage account resource IDs to monitor')
param storageAccountIds array

@description('Availability threshold percentage (alert when below)')
param availabilityThreshold int = environment == 'prod' ? 999 : 995 // Divided by 10 for percentage: 99.9% / 99.5%

@description('E2E latency threshold in milliseconds')
param latencyThresholdMs int = environment == 'prod' ? 500 : 1000

@description('Storage capacity threshold in bytes (default: 4 TiB)')
param capacityThresholdBytes int = environment == 'prod' ? 4398046511104 : 5497558138880 // 4 TiB / 5 TiB

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  AlertDomain: 'Storage'
  Environment: environment
}

// ─── Storage Availability Alert ─────────────────────────────
resource storageAvailabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = [for (storageId, i) in storageAccountIds: {
  name: 'alert-storage-availability-${i}-${environment}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Triggers when storage account availability drops below ${availabilityThreshold / 10}.${availabilityThreshold % 10}%'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [storageId]
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'AvailabilityCheck'
          metricName: 'Availability'
          metricNamespace: 'Microsoft.Storage/storageAccounts'
          operator: 'LessThan'
          threshold: availabilityThreshold / 10
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
        webHookProperties: {}
      }
    ]
  }
}]

// ─── Storage E2E Latency Alert ──────────────────────────────
resource storageLatencyAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = [for (storageId, i) in storageAccountIds: {
  name: 'alert-storage-latency-${i}-${environment}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Triggers when storage E2E latency exceeds ${latencyThresholdMs}ms'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [storageId]
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'LatencyCheck'
          metricName: 'SuccessE2ELatency'
          metricNamespace: 'Microsoft.Storage/storageAccounts'
          operator: 'GreaterThan'
          threshold: latencyThresholdMs
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
        webHookProperties: {}
      }
    ]
  }
}]

// ─── Storage Capacity Alert ─────────────────────────────────
resource storageCapacityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = [for (storageId, i) in storageAccountIds: {
  name: 'alert-storage-capacity-${i}-${environment}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Triggers when storage account capacity approaches the configured limit'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT1H'
    windowSize: 'PT6H'
    scopes: [storageId]
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'CapacityCheck'
          metricName: 'UsedCapacity'
          metricNamespace: 'Microsoft.Storage/storageAccounts'
          operator: 'GreaterThan'
          threshold: capacityThresholdBytes
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
        webHookProperties: {}
      }
    ]
  }
}]

// ─── Outputs ─────────────────────────────────────────────────
output storageAvailabilityAlertIds array = [for (storageId, i) in storageAccountIds: storageAvailabilityAlert[i].id]
output storageLatencyAlertIds array = [for (storageId, i) in storageAccountIds: storageLatencyAlert[i].id]
output storageCapacityAlertIds array = [for (storageId, i) in storageAccountIds: storageCapacityAlert[i].id]
