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

// ── The Gov Brain-scan data-plane principal (Refs #3430, Refs #4014) ───────
// Object id of the DEPLOYING principal, supplied by admin-plane/main.bicep ONLY
// when ARM disclosed no userPrincipalName for it — i.e. a non-interactive CI
// service principal. Empty on an interactive (human) deploy and empty by
// default, which is what keeps the two grants below off every hand-run deploy.
//
// It is threaded as a PARAM rather than read from `deployer()` in this module on
// purpose: `deployer()` is already used for the tenant-admin fallback in
// admin-plane/main.bicep (the proven call site), and this module runs as a
// NESTED deployment, where the repo has no measurement of what `deployer()`
// returns. One leaf-module param costs nothing against the ARM 256-param
// ceiling that admin-plane/main.bicep (240) and main.bicep (226) are ratcheted
// against — neither gains a param from this change.
@description('Object id of the deploying principal, passed ONLY when it is non-interactive (a CI service principal). Grants the Gov Brain-scan lane its narrow Cosmos data-plane access. Empty = no grant, which is the default and the interactive-deploy case.')
param deployerServicePrincipalId string = ''

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

// ---------------------------------------------------------------------------
// W9 (#3935) — Loom Brain GRAPH HISTORY.
//
// Declared as its own resource rather than as a row in `loomContainers` because
// it is the only container here with a TTL, and the loop above emits none. It is
// also the only one partitioned by ESTATE rather than by tenant: the Brain's
// graph is a property of the deployed estate, not of a tenant inside it.
//
// DEPLOYED, NOT REQUESTED (auto-bind-by-default.md §5). The console's
// `CosmosGraphHistoryStore` also createIfNotExists's this container with the same
// partition key and the same TTL, which is the sanctioned idempotent fallback for
// an estate whose Cosmos account predates this module — but the deploy is the
// primary path, so nothing is ever asked of an operator.
//
// RETENTION — the cost bound, stated here and in
// `apps/fiab-console/lib/brain/history/retention.ts`, which must stay in step:
//   defaultTtl 7776000s = 90 days. This is the BACKSTOP, for an estate that
//   stops being captured; count-based pruning only runs when something writes.
//   The primary bound is 50 versions per estate, enforced on every write in
//   `captureGraphVersion`. A version is written only when the graph SEMANTICALLY
//   changed, so 50 is 50 real estate changes, not 50 polls.
//
// CLOUD PARITY — this module is invoked from admin-plane/main.bicep for every
// boundary, so the container exists in Commercial and in Gov alike. The console
// reaches it through `LOOM_COSMOS_ENDPOINT`, which the deploy emits, so no host
// literal appears in the app.
resource brainGraphVersions 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = {
  parent: loomDb
  name: 'brain-graph-versions'
  properties: {
    resource: {
      id: 'brain-graph-versions'
      partitionKey: { paths: ['/estateId'], kind: 'Hash' }
      defaultTtl: 7776000
      indexingPolicy: { indexingMode: 'consistent', automatic: true }
    }
  }
}

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

// ===========================================================================
// GOV BRAIN-SCAN DATA-PLANE GRANT (Refs #3430, Refs #4014, Refs #4051)
// ===========================================================================
//
// ── THE MEASURED PROBLEM ───────────────────────────────────────────────────
// `loom-brain-scan.yml`'s Gov job runs on `ubuntu-latest`. A GitHub-hosted
// runner has NO managed identity, so no credential-chain order can reach one:
// the chain falls through to AzureCliCredential — the Gov deploy service
// principal from the job's `az login`. This account sets `disableLocalAuth:
// true`, so AAD-RBAC is the ONLY data-plane path, and until this block existed
// the deploy SP held no `sqlRoleAssignments` anywhere in the platform bicep.
// The Brain's `recordRun` fires on OK, PAUSED **and** UNREACHABLE alike, so the
// lane could not complete a run in ANY verdict.
//
// The Commercial job runs on `[self-hosted, loom-aca]`, which DOES carry the
// console UAMI, and that identity already holds account-wide Data Contributor
// via `cosmosDataRole` above. Commercial therefore needs nothing here and
// deliberately gains no second writer — see the boundary condition below.
//
// ── WHY THE PRINCIPAL IS `deployer()` AND NOT A LITERAL OID ────────────────
// Two objections were raised against this grant before, and both are answered
// by threading the DEPLOYING principal rather than a configured one:
//   1. No object id ever enters this PUBLIC repository — not in a param file,
//      not in a template, not in the compiled ARM artifact.
//   2. The Gov deploy secret has been exposed in logs once and was rotated. A
//      literal oid would have to be re-supplied on every rotation; a
//      self-referential grant follows the new principal automatically.
// The deploy SP grants ITSELF, and only itself.
//
// ── WHY IT IS GOV-ONLY, AND WHY `environment()` DECIDES ────────────────────
// `environment().suffixes.storage` is evaluated by ARM in the cloud the deploy
// is actually running in (the same discriminator ai-search.bicep and
// aas-server.bicep already use), so it cannot be mis-set by a param file. GCC
// runs on Commercial infrastructure and correctly does NOT match — which is
// right, because the scan workflow's `gov` job authenticates against
// `AzureUSGovernment` specifically.
//
// Per `cloud-parity.md` this asymmetry is STATED, not implied: the capability
// is identical in both boundaries; what differs is the runner topology, and
// this block is what makes the Gov boundary reach the same outcome.
//
// ── WHY NOT ACCOUNT SCOPE, AND WHY NOT DATABASE SCOPE ──────────────────────
// Account scope is what `cosmosDataRole` gives the console UAMI, and handing
// the same reach to a public-repo deploy credential is the exact widening that
// was objected to. DATABASE scope is no better here: `loom` is the ONLY
// database on this account, so `dbs/loom` and the account root have the same
// blast radius — it would cover `env-config`, `azure-connections`,
// `tenant-topology` and every other console container.
//
// So the data grant is CONTAINER-scoped, one assignment per Brain container.
// ===========================================================================

// Gov, non-interactive deployer, grants not suppressed. All three required.
var isAzureUSGovernment = environment().suffixes.storage == 'core.usgovcloudapi.net'
var grantBrainScanDataPlane = isAzureUSGovernment && !empty(deployerServicePrincipalId) && !skipRoleGrants

// The Brain containers this module declares. Container-scoped data grants are
// derived from this list, so a Brain container added WITHOUT a row here simply
// gets no grant — it never silently widens an existing one.
//
// TODAY THIS IS ONE ENTRY. `brain-findings` (#4014 / W10) — which is where
// `recordRun` actually upserts — is NOT declared in this module on `main` yet.
// The lane that adds that container MUST add its name here in the same edit, or
// the Gov scan will still 403 on its run record. That is called out in the PR
// body rather than pre-granted: a role-assignment scope naming a container this
// template does not create is an unverified deploy-time risk, and per
// `deploy-integrity.md` R1/R7 this template does not gamble the whole estate
// deploy on it.
var brainScanContainers = [
  'brain-graph-versions'
]

// ── 1. Account-scoped METADATA read (a custom role: metadata ONLY) ─────────
// The @azure/cosmos client performs an ACCOUNT-level metadata read for endpoint
// discovery before any container request, and `CosmosFindingStore` additionally
// calls `databases.createIfNotExists` — a DATABASE-level metadata read on the
// already-existing database. Neither is reachable from a container-scoped
// assignment, so a purely container-scoped grant would 403 on client bootstrap
// before it ever touched a document.
//
// The built-in Data Reader role would satisfy that read, but it also carries
// `containers/items/read` + `executeQuery` — at account scope that is read
// access to every console container. So this is a CUSTOM role holding exactly
// one data action. It exposes STRUCTURE (database/container names, offers);
// it can read no document.
resource brainScanMetadataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleDefinitions@2024-12-01-preview' = if (grantBrainScanDataPlane) {
  parent: account
  name: guid(account.id, 'loom-brain-scan-metadata-reader')
  properties: {
    roleName: 'Loom Brain Scan Metadata Reader'
    type: 'CustomRole'
    assignableScopes: [ account.id ]
    permissions: [
      {
        dataActions: [
          'Microsoft.DocumentDB/databaseAccounts/readMetadata'
        ]
      }
    ]
  }
}

resource brainScanMetadataAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = if (grantBrainScanDataPlane) {
  parent: account
  name: guid(account.id, deployerServicePrincipalId, 'loom-brain-scan-metadata-reader')
  properties: {
    roleDefinitionId: brainScanMetadataRole!.id
    principalId: deployerServicePrincipalId
    scope: account.id
  }
}

// ── 2. Container-scoped DATA CONTRIBUTOR, per Brain container ──────────────
// Built-in "Cosmos DB Built-in Data Contributor" (00000000-…-000000000002) —
// the same built-in `cosmosDataRole` uses, so no new role id enters the repo.
//
// Data CONTRIBUTOR and not Data Reader because the Brain WRITES: `recordRun`
// and `put` both call `container.items.upsert`. Reader (…0001) carries no
// create/replace/upsert action and would fail on the first run record, in every
// verdict. Contributor is the least-privilege role that actually works.
//
// `dependsOn` on the container is explicit: the assignment names the container
// in its scope path, and nothing else in this template orders them.
resource brainScanDataAssignments 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = [
  for containerName in brainScanContainers: if (grantBrainScanDataPlane) {
    parent: account
    name: guid(account.id, deployerServicePrincipalId, containerName, '00000000-0000-0000-0000-000000000002')
    properties: {
      roleDefinitionId: '${account.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
      principalId: deployerServicePrincipalId
      scope: '${account.id}/dbs/${loomDatabase}/colls/${containerName}'
    }
    dependsOn: [ brainGraphVersions ]
  }
]
