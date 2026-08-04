// CSA Loom — Azure Managed Redis (Microsoft.Cache/redisEnterprise)  [#2642]
// ============================================================================
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
// Azure Cache for Redis (`Microsoft.Cache/redis`, Basic/Standard/Premium) is
// retiring. TIMELINE REVISED BY MICROSOFT IN JULY 2026 — re-verified 2026-08-04
// against Learn "What's New in Azure Cache for Redis": *"Microsoft is removing
// creation block timeline for Basic, Standard, and Premium tiers for ALL
// CLOUDS."* Operative dates are now only 2026-04-01 (creation blocked for NEW
// customers, PUBLIC CLOUD ONLY) and 2028-10-01 (all remaining caches turned
// off). The public/existing 2026-10-01 block and the Azure Government
// 2026-10-01 / 2027-04-01 pair were WITHDRAWN.
//   https://learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new
// Azure Managed Redis (AMR) is the successor and is
// deployed through a DIFFERENT resource provider shape:
//   Microsoft.Cache/redisEnterprise                        (the cluster)
//   Microsoft.Cache/redisEnterprise/databases              (child, name 'default')
//   .../databases/accessPolicyAssignments                  (Entra data access)
//
// This module owns that shape so the two Loom call sites
// (compute/hband-shared.bicep and deploy-planner/redis.bicep) do not each
// hand-roll it.
//
// ── AVAILABILITY — READ THIS BEFORE WIRING A NEW CALLER ─────────────────────
// **Azure Managed Redis is AZURE PUBLIC CLOUD ONLY.** It is NOT available in
// Azure Government. Learn, "Azure Managed Redis planning FAQs" — *"Can I use
// Azure Managed Redis with Azure Government Cloud …? Azure Managed Redis is
// only available in the global Azure cloud."* The Azure Cache for Redis
// planning FAQ says the same thing from the other side: *"The Azure Redis
// Enterprise and Enterprise Flash tiers are available only in the Public
// cloud"* — and AMR **is** that `redisEnterprise` provider.
//   https://learn.microsoft.com/azure/redis/planning-faq
//   https://learn.microsoft.com/azure/azure-cache-for-redis/cache-planning-faq
// Therefore every caller MUST keep a sovereign path on the classic
// `Microsoft.Cache/redis` resource and MUST NOT select this module when the
// deployment boundary is GCC / GCC-High / IL5. Issue #2642 asserted the
// opposite ("Managed Redis is listed as a mainstream service in Azure
// Government"); that conflates Azure *Cache* for Redis (which IS a Gov
// service) with Azure *Managed* Redis (which is not). Do not "fix" Gov by
// pointing it here: it would replace a service that still creates successfully
// there today with one that has never existed in that cloud at all. Microsoft
// Q&A, re-verified 2026-08-04: *"Azure Managed Redis is not available at this
// time, and there is no publicly announced ETA for when support will be
// introduced in Azure Government or other sovereign clouds."*
//   https://learn.microsoft.com/answers/a/12551338
//
// ── NOT A 1:1 PORT OF THE CLASSIC SHAPE ────────────────────────────────────
// Four things genuinely differ and are easy to get wrong by find-and-replace:
//
//  1. ACCESS POLICY ASSIGNMENTS hang off the DATABASE, not the cluster, and
//     carry a different property shape:
//       classic : properties { accessPolicyName: 'Data Contributor'
//                              objectId: <oid>, objectIdAlias: <alias> }
//       AMR     : properties { accessPolicyName: 'default'
//                              user: { objectId: <oid> } }
//     `default` is the ONLY allowed policy name. The classic
//     Data Owner / Data Contributor / Data Reader granularity does NOT exist
//     on AMR — every assignment is full data access. That is a real posture
//     change and is disclosed here rather than papered over.
//
//  2. PORT + HOST. Classic is `<name>.redis.cache.windows.net:6380`. AMR is
//     `<name>.<region>.redis.azure.net:10000`. The Loom client contract
//     (`LOOM_RESULT_CACHE_REDIS` = `host:port`) is unchanged in SHAPE, but the
//     port VALUE differs, so callers must publish this module's `endpoint`
//     output rather than assuming 6380.
//
//  3. CLUSTERING POLICY. AMR is internally clustered on every SKU and the ARM
//     default is `OSSCluster`, which requires a CLUSTER-AWARE client (the
//     client must follow MOVED redirects and open per-shard connections on the
//     85xx ports). Loom's cache client — apps/fiab-console/lib/azure/
//     redis-cache-client.ts — is a hand-rolled RESP2 socket client that speaks
//     exactly AUTH/GET/SET/DEL and has NO cluster support, and it degrades
//     SILENTLY on any error. Under `OSSCluster` the cache would deploy green,
//     the env var would be set, and every GET would fail invisibly. We
//     therefore default to `EnterpriseCluster`, which Learn describes as the
//     policy that "makes Azure Managed Redis look nonclustered to users … Redis
//     client libraries don't need to support Redis Clustering".
//       https://learn.microsoft.com/azure/redis/architecture#clustering
//
//  4. PRIVATE ENDPOINT group id + DNS zone differ:
//       classic : groupIds ['redisCache']      privatelink.redis.cache.windows.net
//       AMR     : groupIds ['redisEnterprise'] privatelink.redis.azure.net
//       https://learn.microsoft.com/azure/private-link/private-endpoint-dns
//
// Grounded in Microsoft Learn:
//   Microsoft.Cache/redisEnterprise            https://learn.microsoft.com/azure/templates/microsoft.cache/redisenterprise
//   .../redisEnterprise/databases              https://learn.microsoft.com/azure/templates/microsoft.cache/2025-07-01/redisenterprise/databases
//   .../databases/accessPolicyAssignments      https://learn.microsoft.com/azure/templates/microsoft.cache/2025-07-01/redisenterprise/databases/accesspolicyassignments
//   AMR + Private Link                         https://learn.microsoft.com/azure/redis/private-link
//   Migrate Basic/Standard/Premium -> AMR      https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview
//
// API VERSION: 2025-07-01 (GA). `publicNetworkAccess` was introduced there and
// Learn states API versions BEFORE 2025-07-01 are deprecated in October 2026 —
// so an older api-version would re-create this same dated problem.
//
// NO Microsoft Fabric / Power BI dependency (no-fabric-dependency.md).
// ============================================================================

targetScope = 'resourceGroup'

@description('Cluster name. Must match ^(?=.{1,60}$)[A-Za-z0-9]+(-[A-Za-z0-9]+)*$ — alphanumerics separated by single hyphens, no leading/trailing hyphen, max 60 chars.')
@minLength(1)
@maxLength(60)
param name string

@description('Deployment region.')
param location string

@description('Azure Managed Redis SKU. Balanced_B0 is the smallest/cheapest. Sizing is deliberately a caller decision — see the AMR pricing page; this list is the GA subset Loom uses, not the full provider enum.')
@allowed([
  'Balanced_B0'
  'Balanced_B1'
  'Balanced_B3'
  'Balanced_B5'
  'Balanced_B10'
  'Balanced_B20'
  'Balanced_B50'
  'MemoryOptimized_M10'
  'MemoryOptimized_M20'
  'MemoryOptimized_M50'
  'ComputeOptimized_X5'
  'ComputeOptimized_X10'
])
param skuName string = 'Balanced_B0'

@description('High availability (replica). Learn: zone redundancy REQUIRES highAvailability=Enabled. Disable only for dev/test — it costs less but accepts data loss and downtime.')
@allowed(['Enabled', 'Disabled'])
param highAvailability string = 'Enabled'

@description('Availability zones for the cluster. Leave EMPTY ([]) in the normal case: per Learn ("Reliability in Azure Managed Redis") a cache is zone redundant when it uses the high-availability configuration in a region that supports zones — the service places the nodes, and each SKU has its own node count, so an enumerated 3-zone list is not necessarily valid. Supply a list only when placement must be pinned.')
param zones array = []

@description('Deny public network access. true => publicNetworkAccess=Disabled (reachable only over the private endpoint this module can wire).')
param publicNetworkDisabled bool = true

@description('Clustering policy. EnterpriseCluster is the DEFAULT ON PURPOSE: Loom\'s redis-cache-client is a hand-rolled RESP2 client with no Redis Cluster support, and OSSCluster would fail silently. Do NOT change to OSSCluster without first making that client cluster-aware.')
@allowed(['EnterpriseCluster', 'NoCluster', 'OSSCluster'])
param clusteringPolicy string = 'EnterpriseCluster'

@description('Redis eviction policy. AllKeysLRU is correct for a pure result/residency cache; VolatileLRU is the provider default.')
@allowed([
  'AllKeysLFU'
  'AllKeysLRU'
  'AllKeysRandom'
  'NoEviction'
  'VolatileLFU'
  'VolatileLRU'
  'VolatileRandom'
  'VolatileTTL'
])
param evictionPolicy string = 'AllKeysLRU'

@description('Allow access-key authentication. Disabled by default: Loom connects with Microsoft Entra tokens through its UAMIs, so there is no shared key to rotate or leak.')
@allowed(['Enabled', 'Disabled'])
param accessKeysAuthentication string = 'Disabled'

@description('Entra data-access grants. Array of { name, objectId } — `name` is the assignment resource name, `objectId` the principal id. NOTE: AMR supports exactly one access policy (`default` = full data access); classic Redis\'s Data Owner/Contributor/Reader split does not exist here. Entries with an empty objectId MUST be filtered out by the caller (ARM cannot skip an element mid-loop).')
param accessAssignments array = []

@description('Private-endpoint subnet resource id. Empty skips PE creation.')
param privateEndpointSubnetId string = ''

@description('privatelink.redis.azure.net private DNS zone id — the AMR zone, which is NOT the classic privatelink.redis.cache.* zone. Empty skips the DNS zone group.')
param privateDnsZoneId string = ''

@description('Private endpoint resource name. Callers pin this so a redeploy updates the same PE instead of creating a duplicate.')
param privateEndpointName string = 'pe-${name}'

@description('Log Analytics workspace resource id for diagnostics. Empty skips the diagnostic-settings wiring (honest no-op).')
param workspaceId string = ''

@description('Compliance / cost tags applied to every resource.')
param complianceTags object = {}

// ── The cluster ─────────────────────────────────────────────────────────────
resource cluster 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: name
  location: location
  tags: complianceTags
  zones: empty(zones) ? null : zones
  sku: {
    name: skuName
  }
  properties: {
    // Empty object == Microsoft-managed key encryption at rest (Learn sample).
    encryption: {}
    highAvailability: highAvailability
    minimumTlsVersion: '1.2'
    publicNetworkAccess: publicNetworkDisabled ? 'Disabled' : 'Enabled'
  }
}

// ── The database (AMR exposes exactly one, and it must be named 'default') ──
resource database 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: cluster
  name: 'default'
  properties: {
    // TLS-only on the data path. There is no separate "non-SSL port" toggle on
    // AMR the way classic Redis had `enableNonSslPort`; the protocol choice IS
    // the control.
    clientProtocol: 'Encrypted'
    clusteringPolicy: clusteringPolicy
    evictionPolicy: evictionPolicy
    accessKeysAuthentication: accessKeysAuthentication
    port: 10000
  }
}

// ── Entra data-access policy assignments ───────────────────────────────────
// Shape differs from classic Redis: parented to the DATABASE, and the
// principal goes in `user.objectId` (not a flat `objectId` + `objectIdAlias`).
resource accessPolicyAssignments 'Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments@2025-07-01' = [
  for a in accessAssignments: {
    parent: database
    name: a.name
    properties: {
      // 'default' is the ONLY value the provider accepts today.
      accessPolicyName: 'default'
      user: {
        objectId: a.objectId
      }
    }
  }
]

// ── Private endpoint + DNS zone group ──────────────────────────────────────
// groupIds is 'redisEnterprise' for AMR — 'redisCache' (the classic sub-
// resource) does not exist on this provider and would fail at deploy time.
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = if (!empty(privateEndpointSubnetId)) {
  name: privateEndpointName
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'redis-link'
        properties: {
          privateLinkServiceId: cluster.id
          groupIds: ['redisEnterprise']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!empty(privateEndpointSubnetId) && !empty(privateDnsZoneId)) {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'redis', properties: { privateDnsZoneId: privateDnsZoneId } }
    ]
  }
}

// ── Diagnostics ────────────────────────────────────────────────────────────
// Same name/categories as modules/shared/diagnostic-settings.bicep so DSC
// drift-detection stays consistent (that helper can only deploy at
// resourceGroup scope — BCP134 — so cross-resource diag is declared here).
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  name: 'diag-loom-stdz'
  scope: cluster
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────

@description('Azure Managed Redis cluster resource id.')
output redisId string = cluster.id

@description('Azure Managed Redis cluster name.')
output redisName string = cluster.name

@description('Cluster host name — <name>.<region>.redis.azure.net (NOT *.redis.cache.windows.net).')
output hostName string = cluster.properties.hostName

@description('TLS data port. AMR is 10000, not the classic 6380.')
output port int = database.properties.port

@description('The LOOM_*_REDIS client contract value: <host>:<port>. Publish THIS rather than composing a port by hand.')
output endpoint string = '${cluster.properties.hostName}:${database.properties.port}'
