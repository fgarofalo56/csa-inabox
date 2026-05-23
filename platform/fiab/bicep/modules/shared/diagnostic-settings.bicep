// CSA Loom — standardized diagnostic settings helper
//
// Every Azure resource in the Loom stack routes its diagnostic logs
// + metrics to the SAME Log Analytics workspace (`law-csa-loom-<region>`)
// in the Admin Plane. This module is invoked with `scope: <resource>`
// by every other module that creates a resource.
//
// Why this pattern:
//   - One LAW = one place to query for cross-resource correlation
//   - Standardized retention (driven by Admin Plane monitoring config)
//   - Standardized log categories (`AllLogs` + `AllMetrics`)
//   - Standardized name (`diag-loom-stdz`) so DSC tooling can detect
//     drift consistently
//
// Usage from a parent module:
//   module diag '../shared/diagnostic-settings.bicep' = {
//     name: 'diag-${myResource.name}'
//     scope: myResource
//     params: {
//       workspaceId: lawId
//       supportedLogCategories: ['AuditLogs', 'AllLogs']
//       supportedMetricCategories: ['AllMetrics']
//     }
//   }

targetScope = 'resourceGroup'

@description('Log Analytics workspace resource ID')
param workspaceId string

@description('Log categories supported by the target resource — pass [] to skip log section. Use \'allLogs\' as a synthetic category to enable categoryGroup=allLogs.')
param supportedLogCategories array = ['allLogs']

@description('Metric categories — typically just [AllMetrics] for Azure resources that support metrics')
param supportedMetricCategories array = ['AllMetrics']

@description('Diagnostic setting name — kept consistent so DSC tooling detects drift')
param settingName string = 'diag-loom-stdz'

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: settingName
  properties: {
    workspaceId: workspaceId
    logs: [for cat in supportedLogCategories: cat == 'allLogs' ? {
      categoryGroup: 'allLogs'
      enabled: true
    } : {
      category: cat
      enabled: true
    }]
    metrics: [for m in supportedMetricCategories: {
      category: m
      enabled: true
    }]
  }
}

output diagnosticSettingId string = diag.id
