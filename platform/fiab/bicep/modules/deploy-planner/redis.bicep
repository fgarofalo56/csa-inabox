// CSA Loom deploy-planner — Redis cache
//
// Wired by the deploy-planner catalog (key: redis → redisEnabled).
// Self-contained: the cheapest functional size with TLS enforced and Microsoft
// Entra authentication so the Loom Console UAMI connects token-only.
//
// ── #2642: WHICH PROVIDER ──────────────────────────────────────────────────
// Azure Cache for Redis (`Microsoft.Cache/redis`) is retiring. Per Microsoft
// Learn, in the Azure PUBLIC cloud new-cache creation is blocked for existing
// customers on 2026-10-01 and every remaining cache is turned off on
// 2028-10-01; in Azure Government creation is blocked for NEW customers on
// 2026-10-01 and for existing customers on 2027-04-01.
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
// provider). main.bicep therefore derives the backend from `boundary` and pins
// GCC / GCC-High / IL5 to 'classic'. Do NOT flip a sovereign deployment to
// 'managed': it would swap a service that stops taking new caches in 2026 for
// one that has never existed in that cloud.
//
// Grounded in Microsoft Learn:
//   Microsoft.Cache/redis            https://learn.microsoft.com/azure/templates/microsoft.cache/redis
//   Microsoft.Cache/redisEnterprise  https://learn.microsoft.com/azure/templates/microsoft.cache/redisenterprise
//   Retirement + migration           https://learn.microsoft.com/azure/redis/migrate/migrate-basic-standard-premium-overview
//   AMR is Public-cloud only         https://learn.microsoft.com/azure/redis/planning-faq

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
