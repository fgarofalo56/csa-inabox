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
//   1. ONE Azure Cache for Redis PREMIUM, zone-redundant, Entra-auth only —
//      backs FOUR consumers off a single metered resource:
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
//   Redis Entra (AAD) auth + access policy assignments
//                                         https://learn.microsoft.com/azure/azure-cache-for-redis/cache-azure-active-directory-for-authentication
//   Zone redundancy (Premium)             https://learn.microsoft.com/azure/azure-cache-for-redis/cache-how-to-zone-redundancy
//   userAssignedIdentities                https://learn.microsoft.com/azure/templates/microsoft.managedidentity/userassignedidentities
//
// NO Microsoft Fabric / Power BI dependency anywhere (no-fabric-dependency.md):
// Redis + UAMIs + Log Analytics are Azure-native and GA in Commercial AND
// Government (GCC / GCC-High / DoD IL4-5) — this substrate is specifically why
// the H-band is Gov-capable.
//
// DEPLOYMENT: standalone out-of-band entrypoint (admin-plane/main.bicep is at the
// 256-param ceiling, so this is NOT wired into an orchestrator; it is
// orphan-allowlisted in scripts/ci/check-bicep-sync.mjs). Deploy with:
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/compute/hband-shared.bicep \
//     -p location=<region> workspaceId=<law-resource-id> \
//        consolePrincipalId=<uami-console-principalId> complianceTags='{...}'
// then set LOOM_DIRECTLAKE_REDIS / LOOM_BROKER_REDIS (+ the per-service app URLs)
// on the Console app via /admin/env-config or `az containerapp update`.
// ============================================================================

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

// ── Shared Redis (Premium, zone-redundant) ──

@description('Redis SKU capacity for the Premium (P) family: 1=P1 (6GB) .. 5=P5 (120GB). P1 is the default floor — enough to hold the Broker timepoint ledger + a working set of Direct Lake segment residency keys. Tune per-tenant.')
@minValue(1)
@maxValue(5)
param redisCapacity int = 1

@description('Availability zones for the zone-redundant Premium cache. Empty ([]) disables zone redundancy (e.g. a region without 3 zones). Default is the standard 3-zone spread.')
param redisZones array = ['1', '2', '3']

@description('Deny public network access (publicNetworkAccess=Disabled) — reachable only over a private endpoint. Default true: the H-band services reach Redis over the CAE-integrated VNet + a private endpoint (wired out-of-band by the networking module), never the public internet. Set false only for a temporary non-PE bring-up.')
param redisPublicNetworkDisabled bool = true

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

// ── 1. Shared Azure Cache for Redis Premium (zone-redundant, Entra-only) ──
resource redis 'Microsoft.Cache/redis@2024-11-01' = {
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
resource redisDirectLakeAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = {
  parent: redis
  name: 'loom-directlake'
  properties: {
    accessPolicyName: 'Data Contributor'
    objectId: uamiDirectLake.properties.principalId
    objectIdAlias: 'uami-loom-directlake'
  }
}

resource redisBrokerAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = {
  parent: redis
  name: 'loom-capacity-broker'
  properties: {
    accessPolicyName: 'Data Contributor'
    objectId: uamiBroker.properties.principalId
    objectIdAlias: 'uami-loom-capacity-broker'
  }
}

resource redisConsoleAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!empty(consolePrincipalId)) {
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
resource redisDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
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

// ── Outputs — consumed by the per-service ACA app modules + admin-plane env ──

@description('Shared Redis cache resource id.')
output redisId string = redis.id

@description('Shared Redis cache name.')
output redisName string = redis.name

@description('Shared Redis host name — the H-band services set LOOM_DIRECTLAKE_REDIS / LOOM_BROKER_REDIS to <hostName>:6380 (SSL).')
output redisHostName string = redis.properties.hostName

@description('Shared Redis SSL port (non-SSL is disabled).')
output redisSslPort int = redis.properties.sslPort

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
