// CSA Loom — Cosmos Gremlin database + NoSQL vector containers
//
// Adds two backings on top of the existing `cosmos.bicep` account:
//
//   1. Gremlin database + graph — drives the `cosmos-gremlin-graph` editor.
//      Uses the `EnableGremlin` capability on a dedicated account so the
//      SQL workloads on the primary Cosmos account stay unaffected.
//
//   2. NoSQL vector containers — drives the `vector-store` editor's
//      `cosmos-nosql` backend (the recommended path per the editor's
//      MessageBar). Each container gets a `VectorEmbeddingPolicy` with
//      a DiskANN index over a 1536-dim float32 embedding column.
//
// Per `no-vaporware.md`: this module is required for the
// `cosmos-gremlin-graph` and `vector-store` editors to leave their
// `LOOM_COSMOS_GREMLIN_ENDPOINT` / `LOOM_COSMOS_VECTOR_ENDPOINT` gates.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary — drives the Gremlin data-plane host suffix (gremlin.cosmos.azure.com vs gremlin.cosmos.azure.us).')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string = 'Commercial'

@description('Domain name')
param domainName string

@description('Private endpoint subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for cosmos (NoSQL Sql group)')
param privateDnsZoneCosmosId string

@description('Private DNS zone ID for cosmos Gremlin (privatelink.gremlin.cosmos.azure.com)')
param privateDnsZoneCosmosGremlinId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Console UAMI principal ID for Cosmos data plane RBAC')
param consolePrincipalId string

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

@description('Vector embedding dimensions (OpenAI default is 1536). DiskANN supports 4096 max.')
param vectorDimensions int = 1536

// =====================================================================
// 1. Cosmos Gremlin account (kind=GlobalDocumentDB + EnableGremlin)
// =====================================================================

var gremlinAccountName = take('cosmos-loom-gremlin-${domainName}-${uniqueString(resourceGroup().id)}', 44)

resource gremlinAccount 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: gremlinAccountName
  location: location
  tags: complianceTags
  kind: 'GlobalDocumentDB'
  identity: { type: 'SystemAssigned' }
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    capabilities: [{ name: 'EnableGremlin' }]
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: 'Continuous7Days' }
    }
  }
}

resource gremlinDb 'Microsoft.DocumentDB/databaseAccounts/gremlinDatabases@2024-12-01-preview' = {
  parent: gremlinAccount
  name: 'loom-graph'
  properties: {
    resource: { id: 'loom-graph' }
    options: { autoscaleSettings: { maxThroughput: 4000 } }
  }
}

resource defaultGraph 'Microsoft.DocumentDB/databaseAccounts/gremlinDatabases/graphs@2024-12-01-preview' = {
  parent: gremlinDb
  name: 'default'
  properties: {
    resource: {
      id: 'default'
      partitionKey: { paths: ['/pk'], kind: 'Hash' }
      indexingPolicy: { indexingMode: 'consistent', automatic: true }
    }
  }
}

// Console UAMI → Cosmos DB Built-in Data Contributor on Gremlin account
// (00000000-0000-0000-0000-000000000002) so the gremlin npm client can
// fetch AAD tokens (the BFF does this — see app/api/items/cosmos-gremlin-graph).
resource gremlinDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  parent: gremlinAccount
  name: guid(gremlinAccount.id, consolePrincipalId, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: '${gremlinAccount.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: consolePrincipalId
    scope: gremlinAccount.id
  }
}

// Private endpoint
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${gremlinAccountName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [{
      name: 'gremlin-link'
      properties: {
        privateLinkServiceId: gremlinAccount.id
        groupIds: ['Gremlin']
      }
    }]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'gremlin-zone', properties: { privateDnsZoneId: privateDnsZoneCosmosGremlinId } }
    ]
  }
}

// =====================================================================
// 2. NoSQL vector account
// =====================================================================
//
// Separate account so vector-store traffic isn't constrained by SQL workloads.
// DiskANN + VectorEmbeddingPolicy require these prerequisites in the
// container's resource definition.
//

var vectorAccountName = take('cosmos-loom-vec-${domainName}-${uniqueString(resourceGroup().id)}', 44)

resource vectorAccount 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: vectorAccountName
  location: location
  tags: complianceTags
  kind: 'GlobalDocumentDB'
  identity: { type: 'SystemAssigned' }
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    capabilities: []
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: 'Continuous7Days' }
    }
  }
}

resource vectorDb 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = {
  parent: vectorAccount
  name: 'loom-vectors'
  properties: {
    resource: { id: 'loom-vectors' }
    options: { autoscaleSettings: { maxThroughput: 4000 } }
  }
}

// "docs-vec" is the default vector container — matches the editor's default
// `indexName` so first-run is one click away from a real index. Additional
// indexes are created via the BFF (POST /api/items/vector-store) which
// PATCHes the item state into Cosmos.
resource defaultVectorContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = {
  parent: vectorDb
  name: 'docs-vec'
  properties: {
    resource: {
      id: 'docs-vec'
      partitionKey: { paths: ['/pk'], kind: 'Hash' }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/_etag/?' }]
        vectorIndexes: [{ path: '/embedding', type: 'diskANN' }]
      }
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [{
          path: '/embedding'
          dataType: 'float32'
          dimensions: vectorDimensions
          distanceFunction: 'cosine'
        }]
      }
    }
  }
}

// Console UAMI → data contributor on the vector account
resource vectorDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  parent: vectorAccount
  name: guid(vectorAccount.id, consolePrincipalId, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: '${vectorAccount.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    principalId: consolePrincipalId
    scope: vectorAccount.id
  }
}

// PE
resource pe2 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${vectorAccountName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [{
      name: 'vector-link'
      properties: {
        privateLinkServiceId: vectorAccount.id
        groupIds: ['Sql']
      }
    }]
  }
}

resource pe2DnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe2
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'cosmos-zone', properties: { privateDnsZoneId: privateDnsZoneCosmosId } }
    ]
  }
}

// =====================================================================
// Diagnostic settings → Loom LAW
// =====================================================================

resource gremlinDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: gremlinAccount
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'GremlinRequests', enabled: true }
      { category: 'DataPlaneRequests', enabled: true }
      { category: 'ControlPlaneRequests', enabled: true }
    ]
    metrics: [{ category: 'Requests', enabled: true }]
  }
}

resource vectorDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: vectorAccount
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'DataPlaneRequests', enabled: true }
      { category: 'QueryRuntimeStatistics', enabled: true }
      { category: 'ControlPlaneRequests', enabled: true }
    ]
    metrics: [{ category: 'Requests', enabled: true }]
  }
}

// =====================================================================
// Outputs (consumed by admin-plane main.bicep → Container Apps env vars)
// =====================================================================

// Gremlin data-plane host suffix is sovereign-cloud-specific: Commercial / GCC
// run on the Commercial Azure environment (gremlin.cosmos.azure.com); GCC-High
// and IL5 run on Azure US Government (gremlin.cosmos.azure.us). Hard-coding the
// Commercial suffix silently breaks the Gremlin endpoint in Gov — mirror the
// TypeScript `gremlinSuffix()` helper so the wired env var is correct per cloud.
var gremlinSuffix = (boundary == 'GCC-High' || boundary == 'IL5') ? 'gremlin.cosmos.azure.us' : 'gremlin.cosmos.azure.com'

output gremlinAccountName string = gremlinAccount.name
output gremlinEndpoint string = 'wss://${gremlinAccount.name}.${gremlinSuffix}:443/'
output gremlinDatabase string = gremlinDb.name
output gremlinGraph string = defaultGraph.name
output vectorAccountName string = vectorAccount.name
output vectorEndpoint string = vectorAccount.properties.documentEndpoint
output vectorDatabase string = vectorDb.name
output vectorDefaultContainer string = defaultVectorContainer.name
