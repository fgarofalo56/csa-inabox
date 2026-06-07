// CSA Loom — Monitoring Reader (subscription scope) for the Console UAMI
//
// The admin console's /monitor surface and the Activator run-history / trigger
// log read control-plane observability across the whole Loom subscription:
//   - metrics            (microsoft.insights/metrics)
//   - activity log       (Microsoft.Insights/eventtypes/management/values)
//   - resource health    (Microsoft.ResourceHealth/availabilityStatuses)
//   - metric alert rules (Microsoft.Insights/metricAlerts)
//   - alert instances    (Microsoft.AlertsManagement/alerts)  ← run history
//
// All of these are subscription-scoped reads, so the Console UAMI needs the
// built-in "Monitoring Reader" role at subscription scope. (Log Analytics
// Reader on the LAW — granted in monitoring.bicep — only covers the KQL Logs
// tab.) Without this grant monitor-client.ts returns an honest 403 gate; with
// it, every /monitor tab + the Activator history grid return live data.
//
// Split into its own subscription-scoped module so the principalId — a module
// OUTPUT in main.bicep — is a plain start-time-known param here, satisfying the
// role-assignment name/if requirements (avoids BCP177).

targetScope = 'subscription'

@description('Console UAMI principalId — granted Monitoring Reader at subscription scope. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Monitoring Reader — 43d0d8ad-25c7-4714-9337-8ba259a9fe05
resource consoleMonitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(subscription().id, consolePrincipalId, 'monitoring-reader')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '43d0d8ad-25c7-4714-9337-8ba259a9fe05')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
