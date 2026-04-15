// Azure Data Explorer (Kusto) - Government Deployment Module
// Real-time analytics engine

@description('Cluster name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('SKU name (VM type + storage).')
param sku string = 'Dev(No SLA)_Standard_E2a_v4'

@description('Enable disk encryption.')
param enableDiskEncryption bool = true

@description('Enable double encryption.')
param enableDoubleEncryption bool = true

@description('Enable streaming ingest.')
param enableStreamingIngest bool = true

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

var isDevSku = startsWith(sku, 'Dev')

resource cluster 'Microsoft.Kusto/clusters@2023-08-15' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
    tier: isDevSku ? 'Basic' : 'Standard'
    capacity: isDevSku ? 1 : 2
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    enableDiskEncryption: enableDiskEncryption
    enableDoubleEncryption: enableDoubleEncryption
    enableStreamingIngest: enableStreamingIngest
    enableAutoStop: isDevSku
    publicNetworkAccess: 'Disabled'
    publicIPType: 'DualStack'
    restrictOutboundNetworkAccess: 'Enabled'
    trustedExternalTenants: []
  }
}

// Default databases for CSA analytics
resource dbRealtime 'Microsoft.Kusto/clusters/databases@2023-08-15' = {
  parent: cluster
  name: 'realtime'
  location: location
  kind: 'ReadWrite'
  properties: {
    softDeletePeriod: 'P90D'
    hotCachePeriod: 'P30D'
  }
}

resource dbTelemetry 'Microsoft.Kusto/clusters/databases@2023-08-15' = {
  parent: cluster
  name: 'telemetry'
  location: location
  kind: 'ReadWrite'
  properties: {
    softDeletePeriod: 'P365D'
    hotCachePeriod: 'P7D'
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: cluster
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'SucceededIngestion', enabled: true }
      { category: 'FailedIngestion', enabled: true }
      { category: 'IngestionBatching', enabled: true }
      { category: 'Command', enabled: true }
      { category: 'Query', enabled: true }
      { category: 'TableUsageStatistics', enabled: true }
      { category: 'TableDetails', enabled: true }
      { category: 'Journal', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output clusterId string = cluster.id
output clusterName string = cluster.name
output clusterUri string = cluster.properties.uri
output principalId string = cluster.identity.principalId
