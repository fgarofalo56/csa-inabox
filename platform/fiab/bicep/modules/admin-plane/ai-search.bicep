// CSA Loom — Azure AI Search (S1+ with vector + integrated vectorization)
// Used by Loom Data Agents CustomSearch tool for unstructured grounding.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('SKU — S1 minimum for vector')
@allowed(['standard', 'standard2', 'standard3', 'storage_optimized_l1', 'storage_optimized_l2'])
param sku string = 'standard'

@description('Partition count')
@minValue(1)
@maxValue(12)
param partitions int = 1

@description('Replica count (3+ for SLA)')
@minValue(1)
@maxValue(12)
param replicas int = 1

@description('Semantic search SKU')
@allowed(['disabled', 'free', 'standard'])
param semanticSearch string = 'standard'

@description('Private endpoint subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for AI Search')
param privateDnsZoneSearchId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Admin Entra group object ID (Search Service Contributor)')
param adminEntraGroupId string

@description('Compliance tags')
param complianceTags object

var searchName = take('search-loom-${uniqueString(resourceGroup().id)}', 60)

resource search 'Microsoft.Search/searchServices@2025-02-01-preview' = {
  name: searchName
  location: location
  tags: complianceTags
  sku: { name: sku }
  identity: { type: 'SystemAssigned' }
  properties: {
    partitionCount: partitions
    replicaCount: replicas
    semanticSearch: semanticSearch
    publicNetworkAccess: 'disabled'
    networkRuleSet: {
      bypass: 'AzureServices'
      ipRules: []
    }
    disableLocalAuth: true
    authOptions: null
    encryptionWithCmk: {
      enforcement: 'Disabled'   // can be enabled with per-tenant CMK
    }
  }
}

// Search Service Contributor role to admin group
resource roleAssign 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: search
  name: guid(search.id, adminEntraGroupId, 'search-contributor')
  properties: {
    // Search Service Contributor
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${searchName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'search-link'
        properties: {
          privateLinkServiceId: search.id
          groupIds: ['searchService']
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
      { name: 'search', properties: { privateDnsZoneId: privateDnsZoneSearchId } }
    ]
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: search
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'OperationLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output searchId string = search.id
output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
