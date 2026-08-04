// CSA Loom deploy-planner — Redis cache
//
// Wired by the deploy-planner catalog (key: redis → redisEnabled).
// Self-contained: the cheapest functional size with TLS enforced and Microsoft
// Entra authentication so the Loom Console UAMI connects token-only.
//
// ── #2642: WHICH PROVIDER ──────────────────────────────────────────────────
// Azure Cache for Redis (`Microsoft.Cache/redis`) is retiring.
//
// TIMELINE — REVISED BY MICROSOFT IN JULY 2026. Re-verified 2026-08-04 against
// Learn "What's New in Azure Cache for Redis", section "July 2026": *"Microsoft
// is removing creation block timeline for Basic, Standard, and Premium tiers
// for ALL CLOUDS."* The operative dates are now only:
//   2026-04-01  creation blocked for NEW customers — IN THE PUBLIC CLOUD ONLY
//   2028-10-01  all remaining Basic/Standard/Premium caches turned off
// The previously-announced public/existing 2026-10-01 block, and the Azure
// Government pair 2026-10-01 (new) / 2027-04-01 (existing), were WITHDRAWN by
// that update. This module used to state them as fact; they are corrected here
// rather than deleted so the next reader knows the old table is retracted and
// does not "restore" it from the AVM redis README or an Advisor string, both of
// which still print it.
//
// NET EFFECT ON A SOVEREIGN FROM-SCRATCH DEPLOY: the classic path is NOT
// creation-blocked in 2026. 2028-10-01 is a migrate-before deadline.
//
// So this module picks a backend:
//   redisBackend='managed' (DEFAULT) — Azure Managed Redis
//     (Microsoft.Cache/redisEnterprise) via modules/shared/managed-redis.bicep.
//   redisBackend='classic'           — the legacy Microsoft.Cache/redis cache.
//
// **Azure Managed Redis is AZURE PUBLIC CLOUD ONLY** — it does not exist in
// Azure Government (Learn, "Azure Managed Redis planning FAQs": *"Azure Managed
// Redis is only available in the global Azure cloud"*; and the Azure Cache for
// Redis planning FAQ: *"The Azure Redis Enterprise and Enterprise Flash tiers
// are available only in the Public cloud"* — AMR is that `redisEnterprise`
// provider). Microsoft Q&A confirms there is still **no announced ETA** for AMR
// in Azure Government (re-verified 2026-08-04). main.bicep therefore derives the
// backend from `boundary` and pins GCC / GCC-High / IL5 to 'classic'. Do NOT
// flip a sovereign deployment to 'managed': it would swap a working service for
// one that has never existed in that cloud.
//
// Grounded in Microsoft Learn:
//   Microsoft.Cache/redis            https://learn.microsoft.com/azure/templates/microsoft.cache/redis
//   Microsoft.Cache/redisEnterprise  https://learn.microsoft.com/azure/templates/microsoft.cache/redisenterprise
//   REVISED retirement timeline      https://learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new
//   Retirement + migration           https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview
//   AMR is Public-cloud only         https://learn.microsoft.com/azure/redis/planning-faq
//   No AMR-in-Gov ETA                https://learn.microsoft.com/answers/a/12551338

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Which Redis provider to deploy. "managed" = Azure Managed Redis (Microsoft.Cache/redisEnterprise), the forward path — AZURE PUBLIC CLOUD ONLY. "classic" = the retiring Microsoft.Cache/redis cache — the only option in Azure Government.')
@allowed(['managed', 'classic'])
param redisBackend string = 'managed'

var useManagedRedis = redisBackend == 'managed'

@description('Azure Managed Redis SKU (redisBackend=managed). Balanced_B0 is the cheapest functional size — the AMR analogue of the classic Basic C0 this replaces. Ignored when redisBackend=classic.')
@allowed([
  'Balanced_B0'
  'Balanced_B1'
  'Balanced_B3'
  'Balanced_B5'
  'Balanced_B10'
  'MemoryOptimized_M10'
  'ComputeOptimized_X5'
])
param managedRedisSku string = 'Balanced_B0'

@description('High availability (replica) for the managed backend. Disabled by default so this opt-in sandbox service stays near the classic Basic-C0 cost point — the classic Basic tier had no replication either. Set Enabled for anything beyond dev/test.')
@allowed(['Enabled', 'Disabled'])
param managedRedisHighAvailability string = 'Disabled'

@description('Cache SKU family + capacity for the CLASSIC backend. Basic C0 is the cheapest functional size. Ignored when redisBackend=managed.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Basic'

@description('SKU family — C (Basic/Standard) or P (Premium). Classic backend only.')
@allowed(['C', 'P'])
param skuFamily string = 'C'

@description('SKU capacity (0-6 for C family; 1-5 for P family). Classic backend only.')
@minValue(0)
@maxValue(6)
param skuCapacity int = 0

@description('Loom Console UAMI principal ID — granted Redis data access so the BFF can connect with Entra auth. Empty skips the assignment. NOTE: on the managed backend Azure Managed Redis supports exactly one access policy name ("default" = full data access); the classic Data Owner/Contributor/Reader split does not exist there.')
param consolePrincipalId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var cacheName = take('redis-loom-${uniqueString(resourceGroup().id)}', 63)

// AMR cluster name — kept distinct from cacheName so both can coexist in one
// resource group during a migration and stay legible in the portal. AMR name
// constraint is ^(?=.{1,60}$)[A-Za-z0-9]+(-[A-Za-z0-9]+)*$; 9 + 13 = 22 chars.
var managedCacheName = 'amr-loom-${uniqueString(resourceGroup().id)}'

@description('Deny public network access (publicNetworkAccess=Disabled) — reachable only over a private endpoint. Default false: this opt-in deploy-planner sandbox service is provisioned with no private-endpoint wiring, so it stays publicly reachable behind Entra-only auth. Set true after wiring a private endpoint to harden. Derivation mirrors admin-plane/ai-foundry.bicep.')
param privateEndpointsEnabled bool = false

var effectivePublicNetworkAccess = privateEndpointsEnabled ? 'Disabled' : 'Enabled'

// ── Managed backend (default) ──────────────────────────────────────────────
module managedRedis '../shared/managed-redis.bicep' = if (useManagedRedis) {
  name: 'dp-managed-redis'
  params: {
    name: managedCacheName
    location: location
    skuName: managedRedisSku
    highAvailability: managedRedisHighAvailability
    publicNetworkDisabled: privateEndpointsEnabled
    // VolatileLRU is the provider default and the right posture for a general
    // sandbox cache (the H-band result cache uses AllKeysLRU instead).
    evictionPolicy: 'VolatileLRU'
    accessAssignments: empty(consolePrincipalId)
      ? []
      : [{ name: 'loom-console', objectId: consolePrincipalId }]
    complianceTags: complianceTags
  }
}

// ── Classic backend (retiring; the only option in Azure Government) ─────────
resource redis 'Microsoft.Cache/redis@2024-11-01' = if (!useManagedRedis) {
  name: cacheName
  location: location
  tags: complianceTags
  properties: {
    sku: {
      name: skuName
      family: skuFamily
      capacity: skuCapacity
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: effectivePublicNetworkAccess
    redisConfiguration: {
      'aad-enabled': 'true'
    }
  }
}

// Microsoft Entra ID data-access policy assignment — Data Owner for the Loom
// Console UAMI so the BFF connects token-only (no access key needed).
resource redisAadAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!useManagedRedis && !empty(consolePrincipalId)) {
  parent: redis
  name: 'loom-console'
  properties: {
    accessPolicyName: 'Data Owner'
    objectId: consolePrincipalId
    objectIdAlias: 'loom-console'
  }
}

output cacheId string = useManagedRedis ? managedRedis!.outputs.redisId : redis!.id
output cacheName string = useManagedRedis ? managedRedis!.outputs.redisName : redis!.name
output hostName string = useManagedRedis ? managedRedis!.outputs.hostName : redis!.properties.hostName

@description('TLS port — 10000 on Azure Managed Redis, 6380 on the classic cache.')
output sslPort int = useManagedRedis ? managedRedis!.outputs.port : redis!.properties.sslPort

@description('The LOOM_*_REDIS client contract value: <host>:<port>, already correct for whichever backend was deployed. Publish THIS instead of composing host + a hard-coded 6380.')
output endpoint string = useManagedRedis
  ? managedRedis!.outputs.endpoint
  : '${redis!.properties.hostName}:${redis!.properties.sslPort}'

@description('Which Redis provider was actually deployed ("managed" = redisEnterprise, "classic" = redis).')
output redisBackendDeployed string = redisBackend

// An HONEST, DATED notice rather than a silent break (#2642). The classic
// provider still creates successfully in Azure Government today — the 2026
// creation blocks were withdrawn in July 2026 — but it IS on a retirement path
// with a hard turn-off, and a deploy that quietly hands back a retiring
// resource is exactly the silent break this output exists to prevent. Surfaced
// as an output so it lands in `az deployment sub show --query properties.outputs`
// and in the deploy-planner receipt, where a human actually reads it.
@description('Retirement posture of the Redis backend that was deployed. Empty-ish ("none") on the managed backend; on classic it names the hard turn-off date so the deploy receipt cannot omit it.')
output redisRetirementNotice string = useManagedRedis
  ? 'none — Azure Managed Redis (Microsoft.Cache/redisEnterprise) is the forward path and is not retiring.'
  : 'ACTION REQUIRED BEFORE 2028-10-01 — this deployment created a RETIRING Azure Cache for Redis (Microsoft.Cache/redis). Microsoft turns off all remaining Basic/Standard/Premium caches on 2028-10-01. The 2026-10-01 / 2027-04-01 creation blocks were WITHDRAWN in July 2026 (https://learn.microsoft.com/azure/azure-cache-for-redis/cache-whats-new), so creation still works — but migration is still required. Azure Managed Redis is Azure Public cloud only and has no announced Azure Government date, so a sovereign estate must plan either an AMR-in-Gov arrival or a non-Redis / OSS-Redis result-cache backend. Migration guide: https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview'
