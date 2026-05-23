// CSA Loom DLZ — Cosmos DB for application state
// Used by:
//   - Mirroring Engine: per-mirror configuration
//   - Activator Engine: per-rule state + suppression windows (Redis is
//                       primary; Cosmos is durable backup)
//   - Direct-Lake Shim: per-table refresh policy
//   - Loom Data Agents: per-agent configuration
//
// Single account per DLZ; separate databases per workload.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name')
param domainName string

@description('Private endpoint subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for cosmos')
param privateDnsZoneCosmosId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Compliance tags')
param complianceTags object

@description('Allowed consistency')
@allowed(['Strong', 'BoundedStaleness', 'Session', 'ConsistentPrefix', 'Eventual'])
param defaultConsistency string = 'Session'

var accountName = take('cosmos-loom-${domainName}-${uniqueString(resourceGroup().id)}', 44)

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: accountName
  location: location
  tags: complianceTags
  kind: 'GlobalDocumentDB'
  identity: { type: 'SystemAssigned' }
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: { defaultConsistencyLevel: defaultConsistency }
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: true }
    ]
    enableAutomaticFailover: false
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    networkAclBypass: 'AzureServices'
    capabilities: []
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: 'Continuous7Days' }
    }
    minimalTlsVersion: 'Tls12'
  }
}

// Databases per workload
var databases = [
  { name: 'mirroring-config', containers: [
      { name: 'mirrors', partitionKey: '/workspaceId' }
      { name: 'mirror-status', partitionKey: '/mirrorId' }
    ] }
  { name: 'activator-state', containers: [
      { name: 'rules', partitionKey: '/workspaceId' }
      { name: 'object-state', partitionKey: '/objectId' }
      { name: 'action-history', partitionKey: '/ruleId' }
    ] }
  { name: 'direct-lake-config', containers: [
      { name: 'refresh-policies', partitionKey: '/semanticModelId' }
      { name: 'refresh-history', partitionKey: '/semanticModelId' }
    ] }
  { name: 'data-agents-config', containers: [
      { name: 'agents', partitionKey: '/workspaceId' }
      { name: 'verified-answers', partitionKey: '/agentId' }
      { name: 'example-queries', partitionKey: '/agentId' }
    ] }
  { name: 'workspace-registry', containers: [
      { name: 'workspaces', partitionKey: '/id' }
      { name: 'items', partitionKey: '/workspaceId' }
    ] }
]

// Databases — one per workload
resource dbs 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = [for db in databases: {
  parent: account
  name: db.name
  properties: {
    resource: { id: db.name }
    options: { autoscaleSettings: { maxThroughput: 4000 } }
  }
}]

// Containers — first container per DB only. Nested loops aren't
// directly supported in Bicep top-level resources; production
// flattens via a deploy-script post-step or a sub-module.
// Using full slash-path resource name + dependsOn since `parent:`
// can't take an array-indexed expression directly.
resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = [for (db, i) in databases: {
  parent: dbs[i]
  name: db.containers[0].name
  properties: {
    resource: {
      id: db.containers[0].name
      partitionKey: { paths: [db.containers[0].partitionKey], kind: 'Hash' }
      indexingPolicy: { indexingMode: 'consistent', automatic: true }
    }
  }
}]

// Private endpoint
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${accountName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'cosmos-link'
        properties: {
          privateLinkServiceId: account.id
          groupIds: ['Sql']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'cosmos-zone', properties: { privateDnsZoneId: privateDnsZoneCosmosId } }
    ]
  }
}

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: account
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'DataPlaneRequests', enabled: true }
      { category: 'MongoRequests', enabled: true }
      { category: 'QueryRuntimeStatistics', enabled: true }
      { category: 'PartitionKeyStatistics', enabled: true }
      { category: 'PartitionKeyRUConsumption', enabled: true }
      { category: 'ControlPlaneRequests', enabled: true }
      { category: 'CassandraRequests', enabled: true }
      { category: 'GremlinRequests', enabled: true }
      { category: 'TableApiRequests', enabled: true }
    ]
    metrics: [
      { category: 'Requests', enabled: true }
    ]
  }
}

output accountId string = account.id
output accountName string = account.name
output endpoint string = account.properties.documentEndpoint
