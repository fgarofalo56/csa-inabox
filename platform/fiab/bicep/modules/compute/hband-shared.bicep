// CSA Loom — Hyperscale band SHARED substrate (HYP-16)
// ============================================================================
// The three H-band services — Loom OneLake (HYP-1), Loom Direct Lake (HYP-5),
// and Loom Capacity Broker (HYP-9) — plus the two supporting services
// (Warm-Pool Keepalive / PSR-3, Shared Result-Cache / PSR-5-6) share ONE
// metered substrate so the resting cost of the whole band is bounded. This
// module owns that shared substrate; the per-service ACA app bicep is shipped
// by each service's own module (compute/loom-onelake-app.bicep,
// compute/loom-directlake-app.bicep, compute/loom-capacity-broker-app.bicep) —
// this module deliberately does NOT duplicate them.
//
// What it provisions (the amortized shared layer, per PRP §3 + §8 dedup table):
//   1. ONE shared Redis cache, zone-redundant, Entra-auth only — backs FOUR
//      consumers off a single metered resource. Since #2642 the backend is
//      selectable via `redisBackend`:
//        'managed' (DEFAULT) — Azure Managed Redis (Microsoft.Cache/
//          redisEnterprise) via modules/shared/managed-redis.bicep. Azure
//          Cache for Redis is retiring: Public-cloud creation is blocked for
//          existing customers on 2026-10-01 and all caches are turned off on
//          2028-10-01.
//        'classic' — the legacy Microsoft.Cache/redis Premium cache. This is
//          the ONLY option in Azure Government: Azure Managed Redis is Azure
//          Public cloud only (Learn, AMR planning FAQ). Sovereign callers MUST
//          pass redisBackend='classic'.
//      The four consumers:
//        - Loom Direct Lake segment-residency index
//          (key {tableId, deltaVersion, columnId, rowGroupId} -> Arrow IPC bytes)
//        - Loom Capacity Broker 2,880 x 30-second timepoint LCU ledger
//        - Warm-Pool Keepalive shared cross-replica Spark/AML lease store (PSR-3)
//        - Shared Result-Cache (the query-cache.ts "back with Redis later" tier)
//   2. THREE dedicated LEAST-PRIVILEGE user-assigned managed identities — one per
//      P0 service. Each is created here (shared identity substrate) but its
//      data-plane grants live with the resource being granted (correct RBAC
//      hygiene; documented per-UAMI below). Redis data-access policy assignments
//      for the two Redis consumers (Direct Lake + Broker) ARE wired here because
//      the Redis cache lives in this module's scope.
//   3. Standardized Azure Monitor diagnostic settings on the Redis cache via the
//      shared modules/shared/diagnostic-settings.bicep helper (one LAW, one
//      setting name, allLogs + AllMetrics) — the diag pattern every H-band ACA
//      app follows.
//
// Grounded in Microsoft Learn:
//   Microsoft.Cache/redis                 https://learn.microsoft.com/azure/templates/microsoft.cache/redis
//   Microsoft.Cache/redisEnterprise (AMR) https://learn.microsoft.com/azure/templates/microsoft.cache/redisenterprise
//   Azure Cache for Redis retirement      https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview
//   AMR is Public-cloud only              https://learn.microsoft.com/azure/redis/planning-faq
//   Redis Entra (AAD) auth + access policy assignments
//                                         https://learn.microsoft.com/azure/azure-cache-for-redis/cache-azure-active-directory-for-authentication
//   Zone redundancy (Premium)             https://learn.microsoft.com/azure/azure-cache-for-redis/cache-how-to-zone-redundancy
//   userAssignedIdentities                https://learn.microsoft.com/azure/templates/microsoft.managedidentity/userassignedidentities
//
// NO Microsoft Fabric / Power BI dependency anywhere (no-fabric-dependency.md):
// Redis + UAMIs + Log Analytics are Azure-native, and a Redis of SOME flavour is
// available in Commercial AND Government (GCC / GCC-High / DoD IL4-5) — this
// substrate is specifically why the H-band is Gov-capable. The FLAVOUR differs
// though: Azure Managed Redis is Azure Public cloud only, so a Gov deploy MUST
// pass `redisBackend=classic` (see the param below).
//
// DEPLOYMENT: standalone out-of-band entrypoint (admin-plane/main.bicep is at the
// 256-param ceiling, so this is NOT wired into an orchestrator; it is
// orphan-allowlisted in scripts/ci/check-bicep-sync.mjs). Deploy with:
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/compute/hband-shared.bicep \
//     -p location=<region> workspaceId=<law-resource-id> \
//        consolePrincipalId=<uami-console-principalId> complianceTags='{...}'
// Add `redisBackend=classic` in Azure Government, or when redeploying against an
// EXISTING classic cache you are not ready to migrate — the default 'managed'
// creates a NEW Azure Managed Redis cluster and does not touch the old cache.
// then set LOOM_DIRECTLAKE_REDIS / LOOM_BROKER_REDIS (+ the per-service app URLs)
// on the Console app via /admin/env-config or `az containerapp update` — use the
// module's `redisEndpoint` output, which already carries the right port (10000
// on managed, 6380 on classic).
// ============================================================================

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

// ── Shared Redis (zone-redundant) ──

// #2642 — Azure Cache for Redis is retiring (Public cloud: creation blocked for
// existing customers 2026-10-01; every cache off 2028-10-01). 'managed' is the
// forward path. It is NOT available in Azure Government — AMR is Azure Public
// cloud only (Learn, "Azure Managed Redis planning FAQs"), so a sovereign
// caller MUST pass 'classic'. See modules/shared/managed-redis.bicep.
@description('Which Redis provider backs the shared cache. "managed" = Azure Managed Redis (Microsoft.Cache/redisEnterprise) — the forward path, AZURE PUBLIC CLOUD ONLY. "classic" = the legacy Microsoft.Cache/redis Premium cache — required in Azure Government (GCC/GCC-High/IL5), where Azure Managed Redis does not exist, and the value to pass when redeploying against an EXISTING classic cache you do not want to migrate yet.')
@allowed(['managed', 'classic'])
param redisBackend string = 'managed'

var useManagedRedis = redisBackend == 'managed'

@description('Azure Managed Redis SKU (redisBackend=managed). Balanced_B5 is the default floor — the closest small Balanced size to the classic Premium P1 this replaces. Ignored when redisBackend=classic.')
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
param managedRedisSku string = 'Balanced_B5'

@description('privatelink.redis.azure.net zone id (network.bicep outputs privateDnsZoneIds.redisManaged) — the AZURE MANAGED REDIS zone, which is a DIFFERENT zone from the classic privatelink.redis.cache.* one. Used only when redisBackend=managed. Empty skips the DNS zone group.')
param privateDnsZoneRedisManagedId string = ''

@description('Redis SKU capacity for the Premium (P) family: 1=P1 (6GB) .. 5=P5 (120GB). P1 is the default floor — enough to hold the Broker timepoint ledger + a working set of Direct Lake segment residency keys. Tune per-tenant. Applies only when redisBackend=classic.')
@minValue(1)
@maxValue(5)
param redisCapacity int = 1

@description('Availability zones for the zone-redundant Premium cache. Empty ([]) disables zone redundancy (e.g. a region without 3 zones). Default is the standard 3-zone spread.')
param redisZones array = ['1', '2', '3']

@description('Deny public network access (publicNetworkAccess=Disabled) — reachable only over a private endpoint. Default true: the H-band services reach Redis over the CAE-integrated VNet + the private endpoint THIS module wires (see privateEndpointSubnetId / privateDnsZoneRedisId). Set false only for a temporary non-PE bring-up.')
param redisPublicNetworkDisabled bool = true

// #53 (2026-07-16): the original claim that the PE was "wired out-of-band by
// the networking module" was FALSE — no PE or privatelink.redis.cache.* zone
// ever existed, so with publicNetworkAccess=Disabled the cache was unreachable
// and the console's redis-cache-client silently fell back to per-replica local
// tiers. The PE now ships FROM THIS MODULE. Both params empty ⇒ skip (honest
// no-op for a non-PE bring-up); supply both for the locked default.
@description('Private-endpoint subnet resource id (hub snet-private-endpoints). Empty skips PE creation.')
param privateEndpointSubnetId string = ''

@description('privatelink.redis.cache.windows.net zone id (Gov: .usgovcloudapi.net) from network.bicep outputs (privateDnsZoneIds.redis). Empty skips the DNS zone group.')
param privateDnsZoneRedisId string = ''

// ── Shared diagnostics ──

@description('Log Analytics workspace resource id (law-csa-loom-<region>) every H-band resource routes diagnostics to. Empty skips the diagnostic-settings wiring (honest no-op — nothing fake is created).')
param workspaceId string = ''

// ── Redis data-access policy principals (Entra-auth, token-only; no access keys) ──

@description('Loom Console BFF UAMI principal id — granted Redis Data Contributor so the console lib clients can read residency/ledger state for the admin surfaces. Empty skips.')
param consolePrincipalId string = ''

@description('Compliance / cost tags applied to every resource.')
param complianceTags object = {}

// Built-in role: AcrPull — used only when acrResourceId is supplied to grant the
// three service UAMIs image-pull on the shared ACR. Data-plane roles (Storage,
// Cosmos) are intentionally NOT granted here; each lives with its target resource.
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

@description('Optional ACR resource id. When supplied AND in this resource group, the three service UAMIs are granted AcrPull on it (image pull). Cross-RG/cross-sub ACR grants are done out-of-band. Empty skips.')
param acrResourceId string = ''

var cacheName = take('redis-loom-hband-${uniqueString(resourceGroup().id)}', 63)

// AMR cluster name. Deliberately NOT `cacheName`: during a migration both the
// classic cache and the new cluster can exist in the same RG, and an operator
// reading the portal needs to tell them apart at a glance. Constraint is
// ^(?=.{1,60}$)[A-Za-z0-9]+(-[A-Za-z0-9]+)*$ — 15 + 13 (uniqueString) = 28.
var managedCacheName = 'amr-loom-hband-${uniqueString(resourceGroup().id)}'

// ── 1. Shared Azure Cache for Redis Premium (zone-redundant, Entra-only) ──
// LEGACY BACKEND — only when redisBackend='classic' (required in Gov).
resource redis 'Microsoft.Cache/redis@2024-11-01' = if (!useManagedRedis) {
  name: cacheName
  location: location
  tags: complianceTags
  zones: empty(redisZones) ? null : redisZones
  properties: {
    sku: {
      name: 'Premium'
      family: 'P'
      capacity: redisCapacity
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: redisPublicNetworkDisabled ? 'Disabled' : 'Enabled'
    redisConfiguration: {
      // Entra (Microsoft Entra ID) auth — the H-band services connect token-only
      // via their UAMIs; no shared access key is ever handed to a service.
      'aad-enabled': 'true'
      // Evict least-recently-used keys under memory pressure — correct for a
      // residency/result cache; the Broker ledger uses short TTLs so it does not
      // rely on eviction for correctness.
      'maxmemory-policy': 'allkeys-lru'
    }
  }
}

// ── 1b. Private endpoint + DNS zone group for the PE-locked cache (#53) ──
// Live estate got this imperatively (pe-redis-loom-hband, 2026-07-16); the
// names match so a redeploy is an idempotent no-op there.
resource redisPe 'Microsoft.Network/privateEndpoints@2024-05-01' = if (!useManagedRedis && !empty(privateEndpointSubnetId)) {
  // NAME MUST STAY 'pe-redis-loom-hband': the live-estate PE was created
  // imperatively under this exact name (2026-07-16) — matching it makes the
  // redeploy an idempotent update instead of a duplicate PE. One hband cache
  // per RG, so the unsuffixed name cannot collide.
  name: 'pe-redis-loom-hband'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'redis-link'
        properties: {
          privateLinkServiceId: redis!.id
          groupIds: ['redisCache']
        }
      }
    ]
  }
}

resource redisPeDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!useManagedRedis && !empty(privateEndpointSubnetId) && !empty(privateDnsZoneRedisId)) {
  parent: redisPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'redis', properties: { privateDnsZoneId: privateDnsZoneRedisId } }
    ]
  }
}

// ── 2. Three dedicated least-privilege service UAMIs ──
// Loom OneLake (HYP-1): needs Storage Blob Data Contributor on the DLZ lake +
//   Cosmos data-plane on the registry containers. Those grants are cross-RG/
//   cross-sub to the DLZ and are done by the per-service module / out-of-band
//   grant against those resources — NOT here. Does NOT use Redis.
resource uamiOnelake 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-onelake-${location}'
  location: location
  tags: complianceTags
}

// Loom Direct Lake (HYP-5): needs Storage Blob Data READER on the DLZ lake only
//   (read-path columnar scan) + Redis data-plane on THIS cache (segment residency).
resource uamiDirectLake 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-directlake-${location}'
  location: location
  tags: complianceTags
}

// Loom Capacity Broker (HYP-9): ZERO data-plane roles by design — it gates the
//   caller, never proxies the call (the least-privilege threat model the
//   script-runner README warns about). It talks to Redis (timepoint ledger) +
//   Cosmos (durable ledger flush) only.
resource uamiBroker 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-capacity-broker-${location}'
  location: location
  tags: complianceTags
}

// ── Redis data-access policy assignments (only the two Redis consumers) ──
// Data Contributor = read+write keys; sufficient for residency index + ledger.
resource redisDirectLakeAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!useManagedRedis) {
  parent: redis
  name: 'loom-directlake'
  properties: {
    accessPolicyName: 'Data Contributor'
    objectId: uamiDirectLake.properties.principalId
    objectIdAlias: 'uami-loom-directlake'
  }
}

resource redisBrokerAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!useManagedRedis) {
  parent: redis
  name: 'loom-capacity-broker'
  properties: {
    accessPolicyName: 'Data Contributor'
    objectId: uamiBroker.properties.principalId
    objectIdAlias: 'uami-loom-capacity-broker'
  }
}

resource redisConsoleAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!useManagedRedis && !empty(consolePrincipalId)) {
  parent: redis
  name: 'loom-console'
  properties: {
    accessPolicyName: 'Data Contributor'
    objectId: consolePrincipalId
    objectIdAlias: 'loom-console'
  }
}

// ── Optional AcrPull grants (same-RG ACR only; cross-RG done out-of-band) ──
// guid() args are all compile-time literals (role id + UAMI name + acr id) — no
// runtime output inside guid() (avoids BCP120). principalId is used only as the
// assignment's principalId value, which is allowed.
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = if (!empty(acrResourceId)) {
  name: last(split(acrResourceId, '/'))
}

resource acrPullOnelake 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(acrResourceId)) {
  name: guid(acrResourceId, 'uami-loom-onelake', acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: uamiOnelake.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPullDirectLake 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(acrResourceId)) {
  name: guid(acrResourceId, 'uami-loom-directlake', acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: uamiDirectLake.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPullBroker 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(acrResourceId)) {
  name: guid(acrResourceId, 'uami-loom-capacity-broker', acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: uamiBroker.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── 3. Standardized diagnostic settings on the shared Redis cache ──
// Routes Redis logs + metrics to the same LAW as the rest of the stack. Declared
// inline as an extension resource (scope: redis) — the standardized
// modules/shared/diagnostic-settings.bicep helper can only deploy at
// resourceGroup scope (BCP134), so cross-resource diag settings are declared
// where the resource lives. Same name (diag-loom-stdz), same categories
// (allLogs + AllMetrics) as that helper so DSC drift-detection stays consistent —
// the diag pattern every H-band ACA app follows (the per-service app modules
// declare the identical block scoped to their Container App).
resource redisDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!useManagedRedis && !empty(workspaceId)) {
  name: 'diag-loom-stdz'
  scope: redis
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

// ── 1-managed. Shared Azure Managed Redis (#2642 forward path, DEFAULT) ──
// Azure Cache for Redis is retiring; this is the successor provider. It carries
// its own PE (different groupId + DNS zone), its own database child, and its own
// Entra access-policy shape — see modules/shared/managed-redis.bicep for why
// this is NOT a find-and-replace of the classic block above.
//
// NOTE ON GRANT GRANULARITY: the classic block grants 'Data Contributor'.
// Azure Managed Redis accepts exactly ONE access policy name — 'default' —
// which is full data access. The three principals below therefore get a
// BROADER grant on the managed backend than on the classic one. That is a
// provider limitation, disclosed rather than hidden.
module managedRedis '../shared/managed-redis.bicep' = if (useManagedRedis) {
  name: 'hband-managed-redis'
  params: {
    name: managedCacheName
    location: location
    skuName: managedRedisSku
    // Zone redundancy on AMR is derived from the HA configuration, not from an
    // enumerated zone list: Learn ("Reliability in Azure Managed Redis") says a
    // cache is zone redundant when it uses the high-availability configuration
    // in a region that supports zones — the service places the nodes. So the
    // existing `redisZones` param is reused only as the "do we want zone
    // redundancy" signal and the explicit list is NOT forwarded (a 3-zone list
    // on a 2-node cluster is not something we can validate without deploying).
    // The module still exposes `zones` for a caller that must pin placement.
    highAvailability: empty(redisZones) ? 'Disabled' : 'Enabled'
    publicNetworkDisabled: redisPublicNetworkDisabled
    // EnterpriseCluster (the module default) is load-bearing: Loom's
    // redis-cache-client has no Redis Cluster support. Do not switch to
    // OSSCluster here without making that client cluster-aware first.
    evictionPolicy: 'AllKeysLRU'
    accessAssignments: concat(
      [
        { name: 'loom-directlake', objectId: uamiDirectLake.properties.principalId }
        { name: 'loom-capacity-broker', objectId: uamiBroker.properties.principalId }
      ],
      empty(consolePrincipalId) ? [] : [{ name: 'loom-console', objectId: consolePrincipalId }]
    )
    privateEndpointSubnetId: privateEndpointSubnetId
    privateDnsZoneId: privateDnsZoneRedisManagedId
    privateEndpointName: 'pe-amr-loom-hband'
    workspaceId: workspaceId
    complianceTags: complianceTags
  }
}

// ── Outputs — consumed by the per-service ACA app modules + admin-plane env ──

@description('Shared Redis resource id (Microsoft.Cache/redisEnterprise when redisBackend=managed, Microsoft.Cache/redis when classic).')
output redisId string = useManagedRedis ? managedRedis!.outputs.redisId : redis!.id

@description('Shared Redis resource name.')
output redisName string = useManagedRedis ? managedRedis!.outputs.redisName : redis!.name

@description('Shared Redis host name. managed => <name>.<region>.redis.azure.net; classic => <name>.redis.cache.<sovereign-suffix>. Do NOT append a port by hand — the two backends listen on different ports; use redisEndpoint.')
output redisHostName string = useManagedRedis ? managedRedis!.outputs.hostName : redis!.properties.hostName

@description('Shared Redis TLS port — 10000 on Azure Managed Redis, 6380 on the classic cache. Non-TLS is disabled on both.')
output redisSslPort int = useManagedRedis ? managedRedis!.outputs.port : redis!.properties.sslPort

@description('The value to set on LOOM_DIRECTLAKE_REDIS / LOOM_BROKER_REDIS / LOOM_SPARK_POOL_REDIS / LOOM_RESULT_CACHE_REDIS: <host>:<port>, already correct for whichever backend was deployed. Publish THIS instead of composing host + a hard-coded 6380.')
output redisEndpoint string = useManagedRedis
  ? managedRedis!.outputs.endpoint
  : '${redis!.properties.hostName}:${redis!.properties.sslPort}'

@description('Which Redis provider was actually deployed ("managed" = Azure Managed Redis / redisEnterprise, "classic" = Azure Cache for Redis / redis).')
output redisBackendDeployed string = redisBackend

@description('Loom OneLake service UAMI resource id (assign to compute/loom-onelake-app.bicep).')
output onelakeUamiId string = uamiOnelake.id

@description('Loom OneLake service UAMI principal id (grant Storage Blob Data Contributor on the DLZ lake + Cosmos data-plane).')
output onelakeUamiPrincipalId string = uamiOnelake.properties.principalId

@description('Loom OneLake service UAMI client id.')
output onelakeUamiClientId string = uamiOnelake.properties.clientId

@description('Loom Direct Lake service UAMI resource id (assign to compute/loom-directlake-app.bicep).')
output directLakeUamiId string = uamiDirectLake.id

@description('Loom Direct Lake service UAMI principal id (grant Storage Blob Data Reader on the DLZ lake; Redis Data Contributor is wired here).')
output directLakeUamiPrincipalId string = uamiDirectLake.properties.principalId

@description('Loom Direct Lake service UAMI client id.')
output directLakeUamiClientId string = uamiDirectLake.properties.clientId

@description('Loom Capacity Broker service UAMI resource id (assign to compute/loom-capacity-broker-app.bicep — ZERO data-plane roles; Redis Data Contributor is wired here).')
output brokerUamiId string = uamiBroker.id

@description('Loom Capacity Broker service UAMI principal id.')
output brokerUamiPrincipalId string = uamiBroker.properties.principalId

@description('Loom Capacity Broker service UAMI client id.')
output brokerUamiClientId string = uamiBroker.properties.clientId
