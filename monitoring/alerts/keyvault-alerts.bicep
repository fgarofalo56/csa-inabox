// ─────────────────────────────────────────────────────────────
// Key Vault Alerts — Azure Key Vault Monitoring
// CSA-in-a-Box Monitoring
//
// Deploys alerts for unauthorized access attempts, expiring
// secrets/certificates, and Key Vault availability.
// ─────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID for Key Vault monitoring')
param logAnalyticsWorkspaceId string

@description('Action group resource ID for alert notifications')
param actionGroupId string

@description('Environment identifier')
@allowed(['dev', 'test', 'prod'])
param environment string = 'dev'

@description('Azure region for alert rule resources')
param location string = resourceGroup().location

@description('Array of Key Vault resource IDs to monitor')
param keyVaultIds array

@description('Secret/certificate expiry warning threshold in days')
param expiryWarningDays int = environment == 'prod' ? 30 : 14

@description('Unauthorized access attempt threshold count')
#disable-next-line no-unused-params // Used in KQL query string interpolation
param unauthorizedAccessThreshold int = environment == 'prod' ? 3 : 10

@description('Key Vault availability threshold percentage (e.g., 999 = 99.9%)')
param availabilityThresholdTenths int = environment == 'prod' ? 999 : 995

// Compute the decimal availability threshold for metric alert
var availabilityThreshold = availabilityThresholdTenths / 10

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  AlertDomain: 'KeyVault'
  Environment: environment
}

// ─── Unauthorized Access Attempts Alert ─────────────────────
resource kvUnauthorizedAccessAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-kv-unauthorized-access-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Key Vault Unauthorized Access Attempts'
    description: 'Triggers when unauthorized access attempts to Key Vault exceed threshold'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where ResourceProvider == 'MICROSOFT.KEYVAULT'
            | where ResultSignature == 'Forbidden' or ResultSignature == 'Unauthorized'
               or httpStatusCode_d == 401 or httpStatusCode_d == 403
            | summarize AttemptCount = count() by Resource, CallerIPAddress, OperationName, bin(TimeGenerated, 15m)
            | where AttemptCount >= ${unauthorizedAccessThreshold}
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

// ─── Secret/Certificate Expiring Soon Alert ─────────────────
resource kvExpiryAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-kv-expiry-warning-${environment}'
  location: location
  tags: tags
  properties: {
    displayName: 'Key Vault Secret/Certificate Expiring Soon'
    description: 'Triggers when secrets or certificates are expiring within ${expiryWarningDays} days'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT6H'
    scopes: [logAnalyticsWorkspaceId]
    windowSize: 'PT6H'
    criteria: {
      allOf: [
        {
          query: '''
            AzureDiagnostics
            | where ResourceProvider == 'MICROSOFT.KEYVAULT'
            | where OperationName in ('SecretNearExpiry', 'CertificateNearExpiry', 'KeyNearExpiry')
            | extend ExpiryDate = todatetime(properties_s)
            | where ExpiryDate <= now() + ${expiryWarningDays}d
            | project Resource, OperationName, id_s, ExpiryDate, TimeGenerated
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

// ─── Key Vault Availability Alert ───────────────────────────
resource kvAvailabilityAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = [for (kvId, i) in keyVaultIds: {
  name: 'alert-kv-availability-${i}-${environment}'
  location: 'global'
  tags: tags
  properties: {
    description: 'Triggers when Key Vault availability drops below ${availabilityThresholdTenths / 10}.${availabilityThresholdTenths % 10}%'
    severity: 1
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    scopes: [kvId]
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'AvailabilityCheck'
          metricName: 'Availability'
          metricNamespace: 'Microsoft.KeyVault/vaults'
          operator: 'LessThan'
          threshold: availabilityThreshold
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
output unauthorizedAccessAlertId string = kvUnauthorizedAccessAlert.id
output expiryAlertId string = kvExpiryAlert.id
output availabilityAlertIds array = [for (kvId, i) in keyVaultIds: kvAvailabilityAlert[i].id]
