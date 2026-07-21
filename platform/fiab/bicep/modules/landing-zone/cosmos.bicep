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

@description('Private DNS zone ID for cosmos. Empty (dlz-attach with no hub DNS coordinates) skips the private DNS zone group.')
param privateDnsZoneCosmosId string = ''

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic setting.')
param workspaceId string = ''

@description('Loom Console UAMI principal ID — granted "DocumentDB Account Contributor" on this account so the Cosmos DB control-plane navigator (databases/containers/stored-procs) can CRUD via ARM AND the Connect panel can call listKeys / listConnectionStrings / regenerateKey. The account sets disableLocalAuth=true, so AAD RBAC is the only data-plane path. "Cosmos DB Operator" is NOT sufficient (it blocks key access). Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

@description('Allowed consistency')
@allowed(['Strong', 'BoundedStaleness', 'Session', 'ConsistentPrefix', 'Eventual'])
param defaultConsistency string = 'Session'

// NOTE: a former `zoneRedundant` param was removed — this account runs in
// Serverless capacity mode, which mandates a single (non-zone-redundant) write
// region, so the option no longer applies. No caller passed it.

// dlz-attach may pass an EMPTY domainName — a bare interpolation would emit
// 'cosmos-loom--<hash>' and Cosmos rejects consecutive hyphens in account
// names ("The character '-' at index N is not allowed"). Collapse the segment.
var domainSegment = empty(domainName) ? '' : '${domainName}-'
var accountName = take('cosmos-loom-${domainSegment}${uniqueString(resourceGroup().id)}', 44)

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: accountName
  location: location
  tags: complianceTags
  kind: 'GlobalDocumentDB'
  identity: { type: 'SystemAssigned' }
  properties: {
    databaseAccountOfferType: 'Standard'
    // SERVERLESS — this account hosts the Console's `loom` database, whose
    // container count exceeds 25 (9 ARM-provisioned admin containers below +
    // the BFF's lazily-created tenant-settings / connections / copilot-* /
    // saved-queries / … via cosmos-client.ts ensure()). A shared-throughput
    // (provisioned/autoscale) database caps at 25 containers, which produced
    // live "collection count exceeded 25" 500s on workspaces/domains (PRP gap
    // #5). Serverless removes the cap and the per-DB/per-container throughput
    // requirement; consumption-billed and well-suited to these metadata/state
    // stores. Set via the top-level capacityMode property (NOT the legacy
    // 'EnableServerless' capability — never set both). Serverless requires a
    // single write region, no zone redundancy, no automatic failover.
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
// scripts/csa-loom/grant-navigator-rbac.sh). Other lazily-created containers
// (PK /tenantId unless noted):
//   tenant-settings, feature-permissions, marketplace-listings, mcp-servers,
//   thread-edges, connections, maintenance-jobs,
//   attribute-groups  ← F17 (custom attributes / attribute groups schema store)
//   saved-queries     ← SQL-database "My Queries" / "Shared Queries" (PK /itemId)
//   folders           ← F10 nested folder hierarchy (PK /workspaceId)
//   task-flows        ← F11 task-flow visual step sequences (PK /workspaceId).
//     Loom-native (Fabric workspace "task flow" parity, no Fabric dependency).
//   task-flow-runs    ← F11 task-flow EXECUTION run history (PK /workspaceId).
//     Loom-native — Fabric task flows can't execute, so this exceeds Fabric.
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
    // NO throughput options — the account is Serverless (capacityMode above),
    // which forbids provisioned/autoscale throughput on its databases/containers.
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
  { name: 'task-flow-runs',    partitionKey: '/workspaceId' }
  // WS-10.3 Time-Machine — time-branch (shadow-workspace) pins. One row per
  // named as-of snapshot over a workspace, PK /workspaceId → single-partition
  // list. createIfNotExists in cosmos-client.ts ensure() is the hotfix fallback.
  { name: 'time-branches',     partitionKey: '/workspaceId' }
  { name: 'embed-codes',       partitionKey: '/tenantId' }
  { name: 'org-visuals',       partitionKey: '/tenantId' }
  { name: 'azure-connections', partitionKey: '/tenantId' }
  { name: 'env-config',        partitionKey: '/tenantId' }
  // Async app-install job tracking (task-019). PK /tenantId matches
  // cosmos-client.ts so every install-dialog poll is a single-partition
  // point-read. createIfNotExists in ensure() remains the hotfix fallback.
  { name: 'app-install-jobs',  partitionKey: '/tenantId' }
  // Tenant topology (audit-t157). One doc per tenant (id='tenant-topology')
  // holding the deployed hub's coordinates (VNet/LAW/DNS/ADX/Cosmos + Console
  // UAMI ids) written by the tenant deploy's post-bootstrap. The Setup Wizard
  // "Add landing zone" flow + the orchestrator's dlz-attach path read it so hub
  // coordinates are never free-typed. PK /tenantId → single-partition read.
  { name: 'tenant-topology',   partitionKey: '/tenantId' }
  // Item version history (Wave-2 W6). One row per saved snapshot of an item's
  // content, PK /itemId so every per-item history list + snapshot-cap prune hits
  // a single physical partition. Dedicated sidecar container (NOT `items`) so
  // version docs never pollute the untyped item-list/count/reindex queries.
  // createIfNotExists in cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'item-versions',     partitionKey: '/itemId' }
  // Access-governance entitlement ledger (access-governance W1). One row per
  // effective grant, PK /principalId → "what can principal X reach" is a
  // single-partition read. Every grant path (F16 workflow, F15 fulfillment,
  // workspace ACL) appends here; the who-has-access report reads it.
  // createIfNotExists in cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'access-assignments', partitionKey: '/principalId' }
  // Access-governance W2 — entitlement bundles + configurable approval policies,
  // PK /tenantId. createIfNotExists in cosmos-client.ts ensure() is the fallback.
  { name: 'access-packages',    partitionKey: '/tenantId' }
  { name: 'approval-policies',  partitionKey: '/tenantId' }
  // Access-governance W4 — recertification campaigns (scope, reviewers, cadence,
  // per-assignment decisions). PK /tenantId. createIfNotExists in
  // cosmos-client.ts ensure() is the hotfix fallback.
  { name: 'access-reviews',     partitionKey: '/tenantId' }
  // WS-10.4 Living Marketplace (BTB-11) — the UNIFIED product exchange. One row
  // per published product across all five kinds (data|agent|mcp|app|ontology),
  // PK /tenantId so the exchange list + publish + subscribe all hit a single
  // physical partition. Auto-certification (gate registry run) + entitlement
  // (access-assignments) + LCU chargeback (cost-attribution) reference it.
  // createIfNotExists in cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'marketplace',        partitionKey: '/tenantId' }
  // Durable cross-session agent memory + per-agent thread persistence (AIF-14).
  // PK /agentId so every per-agent thread list + memory retrieve hits a single
  // physical partition. NO TTL — memory facts are durable; threads are retained
  // until the per-agent retention cap (LOOM_AGENT_THREAD_CAP) evicts the oldest.
  // createIfNotExists in cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'loom-agent-memory', partitionKey: '/agentId' }
  // CTS-08 — long-term Copilot memory brain + its four sidecars. All PK /scopeKey
  // (`user:{oid}` / `workspace:{id}`) so a scope's recall/browse/audit is single-
  // partition and cross-scope leakage is structurally impossible. NO TTL — durable
  // until the per-scope cap (LOOM_COPILOT_MEMORY_CAP) or an explicit purge evicts.
  // Azure AI Search index `copilot-memory-vec` is the ANN mirror (provisioned by
  // the same bootstrap as loom-docs; honest-gates to a Cosmos keyword scan when
  // absent). createIfNotExists in cosmos-client.ts ensure() is the hotfix fallback.
  { name: 'copilot-memory',                 partitionKey: '/scopeKey' }
  { name: 'copilot-memory-flush-log',       partitionKey: '/scopeKey' }
  { name: 'copilot-memory-write-audit',     partitionKey: '/scopeKey' }
  { name: 'copilot-memory-contradictions',  partitionKey: '/scopeKey' }
  { name: 'copilot-topic-pages',            partitionKey: '/scopeKey' }
  // Scoped API tokens (PAT, BR-PAT). One doc per token, PK /id so resolvePat()
  // — the hot path on every non-interactive API request — is a single-partition
  // point-read by the token id in the Authorization: Bearer header. Stores a
  // SHA-256 hash of the secret only (never the secret). createIfNotExists in
  // cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'loom-pat-tokens',   partitionKey: '/id' }
  // BR-SCIM — SCIM 2.0 provisioned users + groups (PK /id). IdP (Entra) pushes
  // identities here via /api/scim/v2; every get/put/patch/delete is a
  // single-partition point-read by the SCIM resource id. createIfNotExists in
  // cosmos-client.ts ensure() is the hotfix fallback.
  { name: 'loom-scim-users',   partitionKey: '/id' }
  { name: 'loom-scim-groups',  partitionKey: '/id' }
  // FGC-25 — Capacity surge-protection policy. One doc per tenant (id=tenantId),
  // PK /tenantId → single-partition point-read. createIfNotExists in
  // cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'capacity-guardrails', partitionKey: '/tenantId' }
  // BR-COSTATTR — per-execution cost attribution ledger. Append-only, PK
  // /tenantId, TTL-enabled (default 90d) so the ledger self-evicts and never
  // grows unbounded. Each row carries its own `ttl`; the container-level
  // defaultTtl: -1 turns TTL ON without imposing a blanket expiry.
  { name: 'cost-attribution',    partitionKey: '/tenantId', ttl: -1 }
  // PSR-3 — warm Spark-session cross-replica lease registry. PK /groupKey so a
  // replica's "claim a warm session in this group" query hits one partition;
  // TTL-enabled (each lease doc carries its own `ttl`) so a crashed replica's
  // leases self-evict. createIfNotExists in cosmos-client.ts ensure() is the
  // hotfix fallback. Only used when the shared substrate is signalled
  // (LOOM_SPARK_POOL_REDIS / LOOM_SPARK_POOL_LEASE_CONTAINER); otherwise idle.
  { name: 'spark-warm-leases',   partitionKey: '/groupKey', ttl: -1 }
  // Brownfield Landing-Zone Service Registry (Phase 1). One doc per attached
  // existing Azure service (Synapse / ADX / ADLS / …) bound to a landing zone
  // (or the hub), PK /tenantId so the per-tenant "what belongs to Loom" list +
  // every per-LZ services read hit a single physical partition. The convergence
  // point for BOTH day-0 BYO (EXISTING_* seed) and the day-2 attach wizard.
  // createIfNotExists in cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'attached-services',   partitionKey: '/tenantId' }
  // Logical Landing-Zone registry (dlz-brownfield Phase A). One doc per
  // lightweight landing zone — a grouping target the attach wizard points
  // attached-services rows at — PK /tenantId so the per-tenant LZ list hits a
  // single physical partition. Distinct from the HEAVY greenfield DLZ (a full
  // ARM deploy discovered via Resource Graph): this store persists a LOGICAL
  // zone with zero Azure provisioning. createIfNotExists in cosmos-client.ts
  // ensure() remains the hotfix fallback.
  { name: 'landing-zones',       partitionKey: '/tenantId' }
  // CTS-07 — Copilot skills registry. `copilot-skills` holds one doc per skill,
  // PK /scope ('builtin' for the seeded MS + Power BI descriptors, or
  // 'tenant:<tid>' for tenant-authored custom skills) so each per-scope
  // enumeration hits a single physical partition. `copilot-skill-states` holds
  // the per-user toggle overrides + the tenant-default overlay, PK /userKey
  // ('user:<oid>' | 'tenant:<tid>'). createIfNotExists in cosmos-client.ts
  // ensure() remains the hotfix fallback. Azure-native — no Fabric dependency.
  { name: 'copilot-skills',        partitionKey: '/scope' }
  { name: 'copilot-skill-states',  partitionKey: '/userKey' }
  // CTS-11 — Copilot skill USAGE telemetry. One lightweight, redacted row per
  // Copilot turn (prompt sample + active-skill names + pane), PK /tenantId so the
  // per-tenant learner scan hits a single physical partition. TTL-enabled with a
  // 90-day container defaultTtl (7776000s) so the rolling telemetry window
  // self-evicts. The skill self-evolution learner reads it to draft SUGGESTED
  // skills (admin-reviewed, never auto-published). createIfNotExists in
  // cosmos-client.ts ensure() remains the hotfix fallback. Azure-native.
  { name: 'copilot-skill-usage',   partitionKey: '/tenantId', ttl: 7776000 }
  // W4 — canvas comments / sticky notes. One row per comment, PK /itemId so
  // every per-item canvas-comments read + the per-canvas retention-cap prune
  // hits a single physical partition (a per-item sidecar like item-versions, so
  // comment docs never pollute the untyped item-list queries). NO TTL — comments
  // are durable until the author deletes or the cap evicts the oldest.
  // createIfNotExists in cosmos-client.ts ensure() remains the hotfix fallback.
  { name: 'canvas-comments',       partitionKey: '/itemId' }
  // W5 — real-time co-authoring presence beacons. One deterministic row per
  // (item, canvas, oid) UPSERTed on heartbeat, PK /itemId so every per-item
  // presence read is a single-partition query. TTL-enabled (each beacon carries
  // its own `ttl` seconds; container-level defaultTtl: -1 turns TTL ON without a
  // blanket expiry) so a peer that closed the tab / crashed self-evicts without
  // an explicit "leave". createIfNotExists in cosmos-client.ts ensure() remains
  // the hotfix fallback.
  { name: 'canvas-presence',       partitionKey: '/itemId', ttl: -1 }
  // WS-5.2 — A2A delegated tasks. One doc per delegated A2A task, PK /tenantId so
  // a caller's tasks/get is single-partition + tenant-isolated. TTL 7 days
  // (604800s) — delegated tasks are short-lived; tasks/get retrieves a recently
  // completed task. createIfNotExists in cosmos-client.ts ensure() remains the
  // hotfix fallback.
  { name: 'a2a-tasks',             partitionKey: '/tenantId', ttl: 604800 }
]

resource loomDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = {
  parent: account
  name: loomDatabase
  properties: {
    resource: { id: loomDatabase }
    // NO throughput options — Serverless account (capacityMode above) forbids
    // provisioned/autoscale throughput, and serverless removes the 25-container
    // shared-throughput cap that broke the Console's >25-container `loom` DB.
  }
}

resource loomDbContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = [for c in loomContainers: {
  parent: loomDb
  name: c.name
  properties: {
    resource: union({
      id: c.name
      partitionKey: { paths: [c.partitionKey], kind: 'Hash' }
      indexingPolicy: { indexingMode: 'consistent', automatic: true }
    }, (c.?ttl != null) ? { defaultTtl: c.?ttl } : {})
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

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!empty(privateDnsZoneCosmosId)) {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'cosmos-zone', properties: { privateDnsZoneId: privateDnsZoneCosmosId } }
    ]
  }
}

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
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

// Console UAMI → Cosmos DB Built-in Data Contributor (data-plane RBAC) on the
// DLZ account. ARM "DocumentDB Account Contributor" above is a CONTROL-plane
// role only — with disableLocalAuth=true the data plane is AAD-RBAC-only, and
// item read/upsert/query (the BFF's app/api/* Cosmos calls — e.g. user-prefs,
// workspaces, items, notifications, tabs-state) all 403 without this SQL role.
// Mirrors the gremlin/vector data-plane grant in cosmos-graph-vector.bicep.
// Built-in Data Contributor definition id is the well-known 00000000-…-000002.
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
