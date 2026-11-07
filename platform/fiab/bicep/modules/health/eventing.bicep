// CSA Loom Health Data Services (LHDS) - stamp Event Hubs namespace.
//
// ADR-007: the transactional outbox is relayed to Event Hubs, which is the
// replayable change log; Service Bus (work queues) is a separate concern. The
// namespace is private only, Entra only (local auth off), and encrypted with
// the stamp CMK. CMK on Event Hubs needs Premium or Dedicated, so the dev
// profile (Standard, Microsoft-managed keys) is the one disclosed exception to
// "CMK everywhere" (ADR-012) and the module says so in an output.

targetScope = 'resourceGroup'

@description('Region of the namespace.')
param location string

@description('Stamp short name; folded into resource names.')
param stampName string

@description('Namespace tier. Premium for class S/M/L (CMK, zone redundancy, 90 day retention). Standard only for the dev profile.')
@allowed(['Standard', 'Premium'])
param skuTier string = 'Premium'

@description('Premium processing units (class S 1, M 2, L 4) or Standard throughput units (dev 1).')
@minValue(1)
@maxValue(16)
param capacity int = 1

@description('Event hubs to create. Names are stamp-level streams; per-tenant hubs are created by tenant.bicep.')
param eventHubs array = [
  {
    name: 'lhds-outbox'
    partitionCount: 8
    retentionDays: 7
  }
  {
    name: 'lhds-changefeed'
    partitionCount: 8
    retentionDays: 7
  }
]

@description('Subnet that hosts the private endpoint.')
param peSubnetId string

@description('Resource id of the privatelink.servicebus private DNS zone (Event Hubs uses the Service Bus zone).')
param eventHubsZoneId string

@description('Resource id of the CMK user-assigned identity. Used only when skuTier is Premium.')
param cmkIdentityId string

@description('Key Vault URI that holds the CMK.')
param keyVaultUri string

@description('Name of the CMK in the vault (version-less).')
param keyName string

@description('Log Analytics workspace id for diagnostics. Empty skips the diagnostic setting.')
param workspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {}

var isPremium = skuTier == 'Premium'
var nsName = take('evh-lhds-${stampName}-${uniqueString(resourceGroup().id)}', 50)

resource ns 'Microsoft.EventHub/namespaces@2024-05-01-preview' = {
  name: nsName
  location: location
  tags: tags
  sku: {
    name: skuTier
    tier: skuTier
    capacity: capacity
  }
  identity: isPremium ? {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${cmkIdentityId}': {}
    }
  } : {
    type: 'None'
  }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    zoneRedundant: isPremium
    encryption: isPremium ? {
      keySource: 'Microsoft.KeyVault'
      requireInfrastructureEncryption: true
      keyVaultProperties: [
        {
          keyName: keyName
          keyVaultUri: keyVaultUri
          identity: { userAssignedIdentity: cmkIdentityId }
        }
      ]
    } : null
  }
}

resource netRules 'Microsoft.EventHub/namespaces/networkRuleSets@2024-05-01-preview' = {
  parent: ns
  name: 'default'
  properties: {
    publicNetworkAccess: 'Disabled'
    defaultAction: 'Deny'
    trustedServiceAccessEnabled: false
  }
}

resource hubs 'Microsoft.EventHub/namespaces/eventhubs@2024-05-01-preview' = [for h in eventHubs: {
  parent: ns
  name: h.name
  properties: {
    partitionCount: h.partitionCount
    retentionDescription: isPremium ? {
      cleanupPolicy: 'Delete'
      retentionTimeInHours: h.retentionDays * 24
    } : null
    messageRetentionInDays: isPremium ? null : min(h.retentionDays, 7)
  }
  dependsOn: [
    netRules
  ]
}]

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${nsName}'
  location: location
  tags: tags
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'eventhubs-link'
        properties: {
          privateLinkServiceId: ns.id
          groupIds: ['namespace']
        }
      }
    ]
  }
  dependsOn: [
    netRules
  ]
}

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'eventhubs'
        properties: { privateDnsZoneId: eventHubsZoneId }
      }
    ]
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: ns
  name: 'diag-lhds-eventhubs'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output namespaceId string = ns.id
output namespaceName string = ns.name
output serviceBusEndpoint string = ns.properties.serviceBusEndpoint
output eventHubNames array = [for (h, i) in eventHubs: hubs[i].name]
output customerManagedKey bool = isPremium
