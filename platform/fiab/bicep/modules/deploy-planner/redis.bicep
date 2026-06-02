// CSA Loom deploy-planner — Azure Cache for Redis
//
// Wired by the deploy-planner catalog (key: redis → redisEnabled).
// Self-contained: a Basic C0 cache (cheapest functional size) with TLS 1.2
// minimum, non-SSL port disabled, and Entra (Microsoft Entra ID) authentication
// enabled so the Loom Console UAMI can connect token-only.
//
// Grounded in Microsoft Learn:
//   Microsoft.Cache/redis  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.cache/redis

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cache SKU family + capacity. Basic C0 is the cheapest functional size.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Basic'

@description('SKU family — C (Basic/Standard) or P (Premium).')
@allowed(['C', 'P'])
param skuFamily string = 'C'

@description('SKU capacity (0-6 for C family; 1-5 for P family).')
@minValue(0)
@maxValue(6)
param skuCapacity int = 0

@description('Loom Console UAMI principal ID — added as a Redis data access policy assignment (Data Owner) so the BFF can connect with Entra auth. Empty skips the assignment.')
param consolePrincipalId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

var cacheName = take('redis-loom-${uniqueString(resourceGroup().id)}', 63)

resource redis 'Microsoft.Cache/redis@2024-11-01' = {
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
    publicNetworkAccess: 'Enabled'
    redisConfiguration: {
      'aad-enabled': 'true'
    }
  }
}

// Microsoft Entra ID data-access policy assignment — Data Owner for the Loom
// Console UAMI so the BFF connects token-only (no access key needed).
resource redisAadAssignment 'Microsoft.Cache/redis/accessPolicyAssignments@2024-11-01' = if (!empty(consolePrincipalId)) {
  parent: redis
  name: 'loom-console'
  properties: {
    accessPolicyName: 'Data Owner'
    objectId: consolePrincipalId
    objectIdAlias: 'loom-console'
  }
}

output cacheId string = redis.id
output cacheName string = redis.name
output hostName string = redis.properties.hostName
