@description('Azure region for deployment')
param parLocation string

@description('''Optional secondary Azure region for multi-region reads/writes.
When set, the account is configured with two locations and — if
enableMultipleWriteLocations is true — both regions accept writes.  The
DR runbook (docs/DR.md) recommends enabling this for any Cosmos account
holding workloads with RPO < 15 minutes.''')
param secondaryLocation string = ''

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
param disableLocalAuth bool = true

@description('Consistency level for Cosmos DB')
@allowed([
  'Strong' // Highest consistency, lower performance
  'Eventual' // Weak consistency, highest performance
  'BoundedStaleness' // Configurable staleness window
  'Session' // Per-session consistency (default)
  'ConsistentPrefix' // Guarantees prefix consistency
])
param consistencyLevel string = 'Session'

@description('Backup mode type.  Continuous is strongly recommended so the rollback procedure in docs/ROLLBACK.md can use point-in-time restore.')
@allowed([
  'Periodic' // Backups with periodic intervals
  'Continuous' // Continuous backups with point-in-time restore
])
param backupPolicyType string = 'Continuous'

@description('Backup interval in minutes (only applies for Periodic backup mode)')
param backupIntervalInMinutes int = 240

@description('Backup retention period in hours (only applies for Periodic backup mode)')
param backupRetentionInHours int = 720

@description('Continuous backup tier (only applies for Continuous backup mode).  30Days enables a 30-day PITR window used by the rollback procedure.')
@allowed([
  'Continuous7Days' // Point-in-time restore for up to 7 days
  'Continuous30Days' // Point-in-time restore for up to 30 days
])
param continuousBackupTier string = 'Continuous30Days'

@description('Enable public network access')
@allowed([
  'Enabled' // Allows public access
  'Disabled' // Restricts to private endpoints or virtual network
])
param publicNetworkAccess string = 'Disabled'

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

@description('Attach a CanNotDelete resource lock to the Cosmos account. Default true for production safety.')
param enableResourceLock bool = true

@description('Log Analytics workspace resource ID for diagnostic settings. Leave empty to skip diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Enable Customer-Managed Key (CMK) encryption.  Default false for dev; set true for prod/compliance.')
param parEnableCmk bool = false

@description('Full Key Vault key URI for CMK (e.g. https://myvault.vault.azure.net/keys/mykey).  Required when parEnableCmk is true.')
param parCmkKeyVaultKeyUri string = ''

// Build the ``locations`` array from the primary location and the optional
// secondary. When secondaryLocation is set we define two failover priorities
// so Azure knows which is primary.
var cosmosLocations = empty(secondaryLocation)
  ? [
      {
        locationName: parLocation
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  : [
      {
        locationName: parLocation
        failoverPriority: 0
        isZoneRedundant: false
      }
      {
        locationName: secondaryLocation
        failoverPriority: 1
        isZoneRedundant: false
      }
    ]

resource cosmosDbAccount 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: cosmosDbAccountName
  location: parLocation
  kind: 'GlobalDocumentDB'
  identity: {
    type: 'SystemAssigned'
  }
  tags: tags
  properties: {
    databaseAccountOfferType: 'Standard'
    locations: cosmosLocations
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
    keyVaultKeyUri: parEnableCmk && !empty(parCmkKeyVaultKeyUri) ? parCmkKeyVaultKeyUri : null
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

// Resource lock — protects the Cosmos account from accidental deletion.
resource cosmosLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: cosmosDbAccount
  name: '${cosmosDbAccountName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: data-lake Cosmos account. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Diagnostic settings — ship all Cosmos logs + metrics to Log Analytics
// so ``csa-event-processing`` and the data-quality runner can correlate
// request IDs across services. See docs/LOG_SCHEMA.md for the shared
// schema and KQL queries.
resource cosmosDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${cosmosDbAccountName}-diagnostics'
  scope: cosmosDbAccount
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output cosmosDbAccountId string = cosmosDbAccount.id
output defaultDatabaseId string = defaultDatabase.id
