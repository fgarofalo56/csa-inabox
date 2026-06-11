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

@description('Loom Console UAMI principal ID — granted "DocumentDB Account Contributor" on this account so the Cosmos DB control-plane navigator (databases/containers/stored-procs) can CRUD via ARM AND the Connect panel can call listKeys / listConnectionStrings / regenerateKey. The account sets disableLocalAuth=true, so AAD RBAC is the only data-plane path. "Cosmos DB Operator" is NOT sufficient (it blocks key access). Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

@description('Allowed consistency')
@allowed(['Strong', 'BoundedStaleness', 'Session', 'ConsistentPrefix', 'Eventual'])
param defaultConsistency string = 'Session'

@description('Zone-redundant write region. Off by default — zonal Cosmos capacity is constrained in eastus2 (per first deploy validation).')
param zoneRedundant bool = false

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
      { locationName: location, failoverPriority: 0, isZoneRedundant: zoneRedundant }
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

// NOTE: The Loom Console creates additional containers lazily at runtime via
// apps/fiab-console/lib/azure/cosmos-client.ts `ensure()` (createIfNotExists),
// in the `loom` database (id = LOOM_COSMOS_DATABASE || 'loom'). The foundation
// admin containers (loom-workspaces, workspace-folders, task-flows, embed-codes,
// org-visuals, azure-connections) are ALSO ARM-provisioned below so a fresh
// environment has them before the Console starts; the createIfNotExists calls
// remain the idempotent fallback for hotfix deploys that skip bicep. The rest
// only require the Console UAMI to hold the Cosmos DB Built-in Data Contributor
// role at account scope (data-plane, not ARM RBAC — bootstrapped by
// scripts/csa-loom/grant-cosmos-rbac.sh). Other lazily-created containers
// (PK /tenantId unless noted):
//   tenant-settings, feature-permissions, marketplace-listings, mcp-servers,
//   thread-edges, connections, maintenance-jobs,
//   attribute-groups  ← F17 (custom attributes / attribute groups schema store)
//   saved-queries     ← SQL-database "My Queries" / "Shared Queries" (PK /itemId)
//   folders           ← F10 nested folder hierarchy (PK /workspaceId)
//   task-flows        ← F11 task-flow visual step sequences (PK /workspaceId).
//     Loom-native (Fabric workspace "task flow" parity, no Fabric dependency).
//   lakehouse-shortcuts (PK /lakehouseId)  ← OneLake-parity internal shortcuts
//     registry (Azure-native, no Fabric). Internal shortcuts need no extra
//     RBAC beyond the UAMI's existing Storage Blob Data Reader on the
//     medallion ADLS account; external (s3/gcs/dataverse/delta_sharing) targets
//     resolve a Key Vault credentialRef via the flat /api/lakehouse/shortcuts.
//
// NOTE (F6 — admin Workspaces list & govern): GET /api/admin/workspaces does a
//   CROSS-PARTITION scan of the lazily-created `loom/workspaces` container
//   (SELECT * FROM c — NO partitionKey filter). This is required because each
//   workspace's tenantId = the CREATOR's OID (not a shared tenant GUID), so a
//   single-partition query would only ever return the admin's own workspaces.
//   The same Cosmos DB Built-in Data Contributor role at account scope (above)
//   authorises the fan-out; no extra RBAC grant is needed for the admin route.
//   copilot-sessions (PK /sessionId, defaultTtl=2419200 — 28-day TTL set by
//     cosmos-client.ts ensure() on create AND via a one-time container
//     replace() upgrade for pre-existing containers; chat sessions expire
//     automatically so "Clear chat" + the 28-day retention need no purge job)
//   copilot-feedback (PK /sessionId, NO TTL)  ← permanent audit log of the
//     per-message thumbs up/down written by PATCH /api/copilot/sessions/[id]
//     (Feedback + clear-chat + history feature). No extra RBAC beyond the
//     UAMI's existing Cosmos DB Built-in Data Contributor at account scope.


// Databases — one per workload
resource dbs 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = [for db in databases: {
  parent: account
  name: db.name
  properties: {
    resource: { id: db.name }
    options: { autoscaleSettings: { maxThroughput: 4000 } }
  }
}]

// Loom Console BFF database + foundation admin containers — provisioned at ARM
// deploy time so a fresh environment has the `loom` database and its core admin
// containers before the Console starts. cosmos-client.ts `ensure()` calls
// createIfNotExists for these (idempotent) on every cold start, so hotfix
// deploys that skip bicep still converge. Partition keys MUST match
// cosmos-client.ts exactly.
var loomDatabase = 'loom'

var loomContainers = [
  { name: 'loom-workspaces',   partitionKey: '/tenantId' }
  { name: 'workspace-folders', partitionKey: '/workspaceId' }
  { name: 'task-flows',        partitionKey: '/workspaceId' }
  { name: 'embed-codes',       partitionKey: '/tenantId' }
  { name: 'org-visuals',       partitionKey: '/tenantId' }
  { name: 'azure-connections', partitionKey: '/tenantId' }
  { name: 'env-config',        partitionKey: '/tenantId' }
  // Async app-install job tracking (task-019). PK /tenantId matches
  // cosmos-client.ts so every install-dialog poll is a single-partition
  // point-read. createIfNotExists in ensure() remains the hotfix fallback.
  { name: 'app-install-jobs',  partitionKey: '/tenantId' }
]

resource loomDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = {
  parent: account
  name: loomDatabase
  properties: {
    resource: { id: loomDatabase }
    options: { autoscaleSettings: { maxThroughput: 4000 } }
  }
}

resource loomDbContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = [for c in loomContainers: {
  parent: loomDb
  name: c.name
  properties: {
    resource: {
      id: c.name
      partitionKey: { paths: [c.partitionKey], kind: 'Hash' }
      indexingPolicy: { indexingMode: 'consistent', automatic: true }
    }
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

// Console UAMI — DocumentDB Account Contributor for the control-plane navigator
// (databases / containers / stored-procedure listing via ARM) AND the Connect
// panel (ARM listKeys / listConnectionStrings / regenerateKey, api-version
// 2024-11-15). The databaseAccounts/* wildcard in this role covers the key
// actions; "Cosmos DB Operator" (230815da-…) is NOT sufficient — it explicitly
// excludes key access. NOTE: this account sets disableLocalAuth=true, so the
// keys exist in ARM but the data plane rejects them (RBAC-only) — the Connect
// panel discloses that honestly.
resource cosmosNavRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, '5bd9cd88-fe45-4216-938b-f97437e15450')
  properties: {
    // DocumentDB Account Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5bd9cd88-fe45-4216-938b-f97437e15450')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output accountId string = account.id
output accountName string = account.name
output endpoint string = account.properties.documentEndpoint
