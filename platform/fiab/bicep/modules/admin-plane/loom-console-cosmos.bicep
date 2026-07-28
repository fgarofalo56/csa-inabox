// CSA Loom — Hub (admin-plane) Cosmos for the Console's own metadata store.
//
// WHY THIS EXISTS: in the `tenant` / `dlz-attach` topologies the hub has NO
// local DLZ, so the DLZ landing-zone `cosmos.bicep` — which hosts the `loom`
// database the Console BFF reads/writes (items, workspaces, configs, copilot
// sessions, tenant-topology, …) — never runs. Yet main.bicep wires the Console's
// LOOM_COSMOS_ACCOUNT/ENDPOINT unconditionally, so the Console points at a Cosmos
// account that was never deployed: it renders + /api/health is 200, but every
// real item/config CRUD fails (the data plane host does not resolve). This module
// provisions the Console's `loom` Cosmos IN THE HUB so a tenant deploy is
// functional with zero DLZs. The DLZ-scoped data-plane Cosmos accounts (Gremlin
// graph + NoSQL vector, per-workload engine state) remain separate and attach
// with each DLZ — this is only the Console's foundation metadata store.
//
// Posture matches cosmos.bicep (FedRAMP-High): publicNetworkAccess Disabled +
// Private Endpoint into the hub VNet, disableLocalAuth (AAD-RBAC only),
// Continuous (PITR) backup — tier via cosmosBackupTier, default Continuous30Days
// (DR0). The Console UAMI gets DocumentDB Account Contributor
// (control-plane navigator + Connect panel) AND Cosmos DB Built-in Data
// Contributor (data-plane item read/upsert/query).

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cosmos account name — MUST equal the name the Console env (LOOM_COSMOS_ACCOUNT) already expects, so no container-app env change is needed.')
param accountName string

@description('Private endpoint subnet ID (hub snet-private-endpoints)')
param privateEndpointSubnetId string

@description('Private DNS zone ID for cosmos (privatelink.documents.azure.<suffix>)')
param privateDnsZoneCosmosId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Console UAMI principal ID — granted DocumentDB Account Contributor (control plane) + Cosmos DB Built-in Data Contributor (data plane). Empty skips grants.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants (re-deploy where grants already exist).')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

@description('Allowed consistency')
@allowed(['Strong', 'BoundedStaleness', 'Session', 'ConsistentPrefix', 'Eventual'])
param defaultConsistency string = 'Session'

@description('DR0 — continuous-backup (PITR) tier for the Console Loom store. Continuous30Days is the GA default (Learn documents Continuous7Days as "in preview") and gives the quarterly DR drill a wide-enough restore window. Switching tiers is a HOT in-place ARM update — no recreate, no downtime (Learn: cosmos-db/migrate-continuous-backup#change-continuous-mode-tiers): the price change takes effect immediately; after a 7→30 upgrade you can only restore within the last 7 days until new backups accumulate; a 30→7 downgrade immediately loses the >7-day window. Rides drConfig.cosmosBackupTier from the orchestrator.')
@allowed(['Continuous7Days', 'Continuous30Days'])
param cosmosBackupTier string = 'Continuous30Days'

// ── CMK1 — customer-managed-key at-rest encryption (opt-in; IL5 mandate) ──
// Mirrors landing-zone/storage.bicep (requireCmk/cmkKeyUri/cmkIdentityId) and
// landing-zone/cosmos.bicep. Learn-grounded (verified 2026-07-24,
// cosmos-db/how-to-setup-customer-managed-keys):
//   - keyVaultKeyUri MUST be VERSIONLESS at account create (no key version, no
//     trailing slash) — rotation auto-tracks the latest enabled version, so
//     there is deliberately NO cmkKeyVersion param (unlike storage.bicep).
//   - This account runs Continuous (PITR) backup, which does NOT support the
//     Cosmos first-party identity for CMK — a user-assigned managed identity
//     must be the account's defaultIdentity (…#use-customer-managed-keys-with-
//     continuous-backup), hence the identity + defaultIdentity shape below.
//   - Enabling CMK on an EXISTING account is a supported hot update
//     (how-to-setup-customer-managed-keys-existing-accounts): add the UAMI +
//     set defaultIdentity first, THEN set --key-uri; document ids must be
//     ≤990 bytes before migration. Rides drConfig.cosmosRequireCmk /
//     cosmosCmkKeyUri / cosmosCmkIdentityId from the orchestrator (R0 bag —
//     admin-plane/main.bicep is param-cap ratcheted).
@description('Require CMK at-rest on the Console Loom-store Cosmos account (CMK1). Default OFF = service-managed keys, unchanged. Requires cmkKeyUri + cmkIdentityId.')
param requireCmk bool = false

@description('VERSIONLESS Key Vault key URI (https://<vault>.vault.azure.<suffix>/keys/<key> — no key version, no trailing slash). Required when requireCmk.')
param cmkKeyUri string = ''

@description('RESOURCE ID of the user-assigned managed identity holding "Key Vault Crypto Service Encryption User" on the key vault. Required when requireCmk (continuous-backup accounts must use a managed identity as defaultIdentity for CMK).')
param cmkIdentityId string = ''

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: accountName
  location: location
  tags: complianceTags
  kind: 'GlobalDocumentDB'
  // CMK1 — the UAMI must be assigned at create so it can serve as
  // defaultIdentity for Key Vault access (system-assigned stays on).
  identity: requireCmk ? {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
    }
  } : { type: 'SystemAssigned' }
  properties: {
    databaseAccountOfferType: 'Standard'
    // SERVERLESS — the Console BFF lazily createIfNotExists()'s well over 25
    // containers (9 pre-created below + tenant-settings, connections, copilot-*,
    // saved-queries, …). A shared-throughput (provisioned/autoscale) database
    // caps at 25 containers, which produced live "collection count exceeded 25"
    // 500s on workspaces/domains (PRP gap #5). Serverless removes the cap and the
    // per-DB/per-container throughput requirement; consumption-billed. Set via the
    // top-level capacityMode property (NOT the legacy 'EnableServerless' capability —
    // never set both). Serverless requires a single write region, no zone
    // redundancy, no automatic failover — all already satisfied above.
    capacityMode: 'Serverless'
    consistencyPolicy: { defaultConsistencyLevel: defaultConsistency }
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: false }
    ]
    enableAutomaticFailover: false
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    networkAclBypass: 'AzureServices'
    capabilities: []
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: cosmosBackupTier }
    }
    minimalTlsVersion: 'Tls12'
    // CMK1 — CMK-at-rest (null = service-managed keys, the default). The key
    // URI is VERSIONLESS (auto-rotate); defaultIdentity is the UAMI because
    // continuous-backup accounts do not support the first-party identity for
    // CMK (see the param-block Learn notes). The DR-posture audit row
    // (svc-dr-restore-posture / probe-dr-restore-posture) live-ARM-verifies
    // this via properties.keyVaultKeyUri when LOOM_COSMOS_REQUIRE_CMK=true.
    keyVaultKeyUri: requireCmk ? cmkKeyUri : null
    defaultIdentity: requireCmk ? 'UserAssignedIdentity=${cmkIdentityId}' : null
  }
}

// Console BFF database. Containers match cosmos-client.ts partition keys exactly;
// the Console's ensure() createIfNotExists is the idempotent fallback for the
// rest of its lazily-created containers (tenant-settings, connections, copilot-*,
// saved-queries, …) — those only need the data-plane role granted below.
var loomDatabase = 'loom'

var loomContainers = [
  { name: 'loom-workspaces',   partitionKey: '/tenantId' }
  { name: 'workspace-folders', partitionKey: '/workspaceId' }
  { name: 'task-flows',        partitionKey: '/workspaceId' }
  { name: 'task-flow-runs',    partitionKey: '/workspaceId' }
  { name: 'embed-codes',       partitionKey: '/tenantId' }
  { name: 'org-visuals',       partitionKey: '/tenantId' }
  { name: 'azure-connections', partitionKey: '/tenantId' }
  { name: 'env-config',        partitionKey: '/tenantId' }
  { name: 'app-install-jobs',  partitionKey: '/tenantId' }
  { name: 'tenant-topology',   partitionKey: '/tenantId' }
  { name: 'function-registry', partitionKey: '/tenantId' }
]

resource loomDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = {
  parent: account
  name: loomDatabase
  properties: {
    resource: { id: loomDatabase }
    // NO throughput options: a serverless account forbids provisioned/autoscale
    // throughput on its databases and containers (deploy fails otherwise).
    // Capacity is account-level (capacityMode: 'Serverless'), consumption-billed.
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

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: account
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'DataPlaneRequests', enabled: true }
      { category: 'QueryRuntimeStatistics', enabled: true }
      { category: 'ControlPlaneRequests', enabled: true }
    ]
    metrics: [
      { category: 'Requests', enabled: true }
    ]
  }
}

// Console UAMI → DocumentDB Account Contributor (control plane: navigator + Connect panel)
resource cosmosNavRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, '5bd9cd88-fe45-4216-938b-f97437e15450')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5bd9cd88-fe45-4216-938b-f97437e15450')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Console UAMI → Cosmos DB Built-in Data Contributor (data plane: item CRUD/query).
// Required because disableLocalAuth=true makes AAD-RBAC the only data-plane path.
resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  parent: account
  name: guid(account.id, consolePrincipalId, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: consolePrincipalId
    scope: account.id
  }
}

output accountId string = account.id
output accountName string = account.name
output endpoint string = account.properties.documentEndpoint
