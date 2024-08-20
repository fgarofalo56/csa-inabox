resource alz_log_analytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  properties: {
    customerId: 'b161f8a2-d232-4923-90f8-2a16a13bd284'
    provisioningState: 'Succeeded'
    sku: {
      name: 'PerGB2018'
      lastSkuUpdate: '2024-07-29T16:52:00.9102291Z'
    }
    retentionInDays: 30
    features: {
      legacy: 0
      searchVersion: 1
      enableLogAccessUsingOnlyResourcePermissions: true
      unifiedSentinelBillingOnly: true
    }
    workspaceCapping: {
      dailyQuotaGb: -1
      quotaNextResetTime: '2024-07-30T01:00:00Z'
      dataIngestionStatus: 'RespectQuota'
    }
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
    createdDate: '2024-07-29T16:52:00.9102291Z'
    modifiedDate: '2024-07-29T18:40:00.4930756Z'
  }
  location: 'East US'
  tags: {
    Owner: 'Azure Landing Zone & Cloud Scale Analytics Scenario'
    Project: 'Azure Demo ALZ & CSA'
    environment: 'dev'
    Toolkit: 'Bicep'
    PrimaryContact: 'frgarofa'
    CostCenter: 'FFL ATU - exp12345'
  }
  name: 'alz-log-analytics'
  etag: '"240382f7-0000-0100-0000-66a7e2000000"'
}
