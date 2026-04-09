@description('Azure region for deployment')
param parLocation string

@description('Name of the Cosmos DB account')
param cosmosDbAccountName string

@description('Name of the default database to create')
param defaultDatabaseName string = 'default'

@description('Enable or disable automatic failover')
param enableAutomaticFailover bool = false

@description('Enable or disable multiple write locations (requires automatic failover to be enabled)')
param enableMultipleWriteLocations bool = false

@description('Enable or disable analytical storage (only available for API=SQL)')
param enableAnalyticalStorage bool = false

@description('Enable free tier for reduced-cost entry level accounts')
param enableFreeTier bool = false

@description('Enable materialized views (preview feature)')
param enableMaterializedViews bool = false

@description('Enable burst capacity for handling spikes in usage')
param enableBurstCapacity bool = false

@description('Enable Cassandra Connector integration')
param enableCassandraConnector bool = false

@description('Enable partition merge to optimize partitioning strategy')
param enablePartitionMerge bool = false

@description('Enable per-region, per-partition autoscale feature')
param enablePerRegionPerPartitionAutoscale bool = false

@description('Enable priority-based execution for queries')
param enablePriorityBasedExecution bool = false

@description('Disable key-based metadata write access (improves security)')
param disableKeyBasedMetadataWriteAccess bool = false

@description('Disable local authentication (use managed identity or AAD instead)')
param disableLocalAuth bool = false

@description('Consistency level for Cosmos DB')
@allowed([
  'Strong' // Highest consistency, lower performance
  'Eventual' // Weak consistency, highest performance
  'BoundedStaleness' // Configurable staleness window
  'Session' // Per-session consistency (default)
  'ConsistentPrefix' // Guarantees prefix consistency
])
param consistencyLevel string = 'Session'

@description('Backup mode type')
@allowed([
  'Periodic' // Backups with periodic intervals
  'Continuous' // Continuous backups with point-in-time restore
])
param backupPolicyType string = 'Periodic'

@description('Backup interval in minutes (only applies for Periodic backup mode)')
param backupIntervalInMinutes int = 240

@description('Backup retention period in hours (only applies for Periodic backup mode)')
param backupRetentionInHours int = 720

@description('Continuous backup tier (only applies for Continuous backup mode)')
@allowed([
  'Continuous7Days' // Point-in-time restore for up to 7 days
  'Continuous30Days' // Point-in-time restore for up to 30 days
])
param continuousBackupTier string = 'Continuous7Days'

@description('Enable public network access')
@allowed([
  'Enabled' // Allows public access
  'Disabled' // Restricts to private endpoints or virtual network
])
param publicNetworkAccess string = 'Enabled'

@description('Network ACL bypass configuration')
@allowed([
  'None' // No bypass; full access control
  'AzureServices' // Allows Azure services to bypass restrictions
])
param networkAclBypass string = 'None'

@description('IP rules to allow specific IP ranges')
param ipRules array = []

@description('Virtual network rules for Cosmos DB account (for private endpoints)')
param virtualNetworkRules array = []

@description('Tags for the Cosmos DB account')
param tags object = {}

resource cosmosDbAccount 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: cosmosDbAccountName
  location: parLocation
  kind: 'GlobalDocumentDB'
  identity: {
    type: 'None' // Use 'SystemAssigned' or 'UserAssigned' for managed identities
    userAssignedIdentities: {}
  }
  tags: tags
  properties: {
    databaseAccountOfferType: 'Standard'
    enableAutomaticFailover: enableAutomaticFailover
    enableMultipleWriteLocations: enableMultipleWriteLocations
    enableAnalyticalStorage: enableAnalyticalStorage
    enableFreeTier: enableFreeTier
    enableBurstCapacity: enableBurstCapacity
    enableMaterializedViews: enableMaterializedViews
    enableCassandraConnector: enableCassandraConnector
    enablePartitionMerge: enablePartitionMerge
    enablePerRegionPerPartitionAutoscale: enablePerRegionPerPartitionAutoscale
    enablePriorityBasedExecution: enablePriorityBasedExecution
    disableKeyBasedMetadataWriteAccess: disableKeyBasedMetadataWriteAccess
    disableLocalAuth: disableLocalAuth
    consistencyPolicy: {
      defaultConsistencyLevel: consistencyLevel
      maxIntervalInSeconds: 5
      maxStalenessPrefix: 100
    }
    backupPolicy: backupPolicyType == 'Periodic'
      ? {
          type: 'Periodic'
          periodicModeProperties: {
            backupIntervalInMinutes: backupIntervalInMinutes
            backupRetentionIntervalInHours: backupRetentionInHours
          }
        }
      : {
          type: 'Continuous'
          tier: continuousBackupTier
        }
    publicNetworkAccess: publicNetworkAccess
    networkAclBypass: networkAclBypass
    ipRules: [
      for ip in ipRules: {
        ipAddressOrRange: ip
      }
    ]
    virtualNetworkRules: [
      for rule in virtualNetworkRules: {
        id: rule.id
        ignoreMissingVNetServiceEndpoint: rule.ignoreMissingVNetServiceEndpoint
      }
    ]
  }
}

resource defaultDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2021-04-15' = if (!empty(defaultDatabaseName)) {
  name: '${cosmosDbAccountName}/${defaultDatabaseName}'
  properties: {
    resource: {
      id: defaultDatabaseName
    }
  }
  dependsOn: [
    cosmosDbAccount
  ]
}

output cosmosDbAccountId string = cosmosDbAccount.id
output defaultDatabaseId string = defaultDatabase.id
