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

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

@description('''Deploy the `loom-governance-items` catalog index via a deployment
script. Default false — the search service is PE-locked (publicNetworkAccess
disabled), so a public deployment script cannot reach its data plane; the Loom
BFF self-heals the index from inside the VNet on first catalog load
(ensureGovernanceCatalogIndex) and on the admin Rebuild-index action. Set true
only when running the script on a VNet-injected ACI that can reach the PE.''')
param deployGovernanceIndex bool = false

@description('Console UAMI resource id — deployment-script identity for the index PUT (needs Search Index Data Contributor on this service).')
param scriptIdentityId string = ''

@description('Console UAMI client id — used by the script to request a search-scoped MSI token.')
param scriptIdentityClientId string = ''

@description('''Console UAMI principal (object) ID. Granted Search Index Data
Contributor on this service so the Loom BFF can run the data-plane index +
document + vector-search operations (PUT /indexes, POST /docs/index, POST
/docs/search) on behalf of the vector-store editor. Leave empty to skip.''')
param consolePrincipalId string = ''

@description('Location of the deployment script (kept distinct so the script can run in a region with ACI quota).')
param scriptLocation string = location

@description('''Resource ID of the storage account that holds debug-session
state (container ms-az-cognitive-search-debugsession). When set, the search
service's system-assigned managed identity is granted Storage Blob Data
Contributor on it, which is required for indexer/skillset debug sessions to
persist their enrichment trace. Leave empty to skip (debug sessions then require
the operator to grant this role + supply a connection string manually).''')
param debugSessionStorageId string = ''

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
resource roleAssign 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: search
  name: guid(search.id, adminEntraGroupId, '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
  properties: {
    // Search Service Contributor
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

// Search Index Data Contributor → Console UAMI.
// Data-plane role required for the Loom BFF (foundry-client.ts searchToken path)
// to PUT /indexes, POST /docs/index, and POST /docs/search — the operations
// behind the vector-store editor's create-index / add-documents / vector-search
// tabs. Without this grant every data-plane call returns 403 even though the
// service is reachable. Role id 8ebe5a00-799e-43f5-93ac-243d3dce84a7.
resource consoleIndexDataRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consolePrincipalId)) {
  scope: search
  name: guid(search.id, consolePrincipalId, '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '8ebe5a00-799e-43f5-93ac-243d3dce84a7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Search Service Contributor → Console UAMI.
// Control-plane role required for the ai-search-index provisioner
// (lib/install/provisioners/ai-search.ts) and the AI Search navigator to manage
// the service object itself: create/update indexes, indexers, data sources and
// skillsets, and read service statistics. The provisioner's own 403 remediation
// names this exact role. Index DATA operations ride consoleIndexDataRole above;
// this grant covers the index/indexer/datasource/skillset LIFECYCLE so the
// provisioner creates+loads indexes day one without a manual grant. Day-one gap
// closure plan §D3. Role id 7ca78c08-252a-4471-8644-bb5ff32d4ba0 (cloud-agnostic).
resource consoleSearchServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consolePrincipalId)) {
  scope: search
  name: guid(search.id, consolePrincipalId, '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '7ca78c08-252a-4471-8644-bb5ff32d4ba0')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Storage account that holds debug-session state (referenced when provided).
// `last(split(id,'/'))` is the account name; the role assignment is scoped to it.
resource debugStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (!empty(debugSessionStorageId)) {
  name: last(split(debugSessionStorageId, '/'))
}

// Storage Blob Data Contributor → search service system-assigned MSI.
// Required for debug sessions to write the enrichment trace to the
// ms-az-cognitive-search-debugsession container. Role id ba92f5b4-2d11-453d-a403-e96b0029c9fe.
resource debugSessionStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(debugSessionStorageId)) {
  scope: debugStorage
  name: guid(search.id, debugSessionStorageId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: search.identity.principalId
    principalType: 'ServicePrincipal'
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

// ---------------------------------------------------------------------------
// loom-governance-items catalog index (optional deployment-script bootstrap).
//
// The Loom BFF is the authoritative path: ensureGovernanceCatalogIndex() PUTs
// this index from inside the VNet the first time the catalog is queried, and
// every item write mirrors a doc into it (push-from-BFF — see
// app/api/items/_lib/item-crud.ts). This script exists so an operator running on
// a VNet-injected ACI can pre-create the index at deploy time; it is gated off
// by default because the PE-locked service is unreachable from a public script.
// ---------------------------------------------------------------------------
resource governanceIndexScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (deployGovernanceIndex && !empty(scriptIdentityId)) {
  name: 'script-loom-governance-catalog-index'
  location: scriptLocation
  tags: complianceTags
  kind: 'AzurePowerShell'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentityId}': {}
    }
  }
  dependsOn: [
    peDnsGroup
  ]
  properties: {
    azPowerShellVersion: '12.0'
    retentionInterval: 'PT1H'
    timeout: 'PT10M'
    environmentVariables: [
      { name: 'SEARCH_ENDPOINT', value: 'https://${search.name}.search.windows.net' }
      { name: 'IDENTITY_CLIENT_ID', value: scriptIdentityClientId }
    ]
    scriptContent: '''
$ErrorActionPreference = 'Stop'
$tokenUri = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://search.azure.com/&client_id=$env:IDENTITY_CLIENT_ID"
$token = (Invoke-RestMethod -Uri $tokenUri -Headers @{ Metadata = 'true' }).access_token
$index = @{
  name = 'loom-governance-items'
  fields = @(
    @{ name = 'id'; type = 'Edm.String'; key = $true; filterable = $true; retrievable = $true }
    @{ name = 'tenantId'; type = 'Edm.String'; filterable = $true; retrievable = $true }
    @{ name = 'workspaceId'; type = 'Edm.String'; filterable = $true; retrievable = $true }
    @{ name = 'workspaceName'; type = 'Edm.String'; retrievable = $true }
    @{ name = 'itemType'; type = 'Edm.String'; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'domainId'; type = 'Edm.String'; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'displayName'; type = 'Edm.String'; searchable = $true; sortable = $true; retrievable = $true; analyzer = 'standard.lucene' }
    @{ name = 'description'; type = 'Edm.String'; searchable = $true; retrievable = $true; analyzer = 'standard.lucene' }
    @{ name = 'owner'; type = 'Edm.String'; retrievable = $true }
    @{ name = 'ownerUpn'; type = 'Edm.String'; searchable = $true; retrievable = $true }
    @{ name = 'classifications'; type = 'Collection(Edm.String)'; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'endorsement'; type = 'Edm.String'; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'sensitivity'; type = 'Edm.String'; filterable = $true; facetable = $true; retrievable = $true }
    @{ name = 'isDiscoverable'; type = 'Edm.Boolean'; filterable = $true; retrievable = $true }
    @{ name = 'updatedAt'; type = 'Edm.DateTimeOffset'; sortable = $true; filterable = $true; retrievable = $true }
    @{ name = 'rowCount'; type = 'Edm.Int64'; sortable = $true; retrievable = $true }
    @{ name = 'sizeBytes'; type = 'Edm.Int64'; sortable = $true; retrievable = $true }
  )
}
$body = $index | ConvertTo-Json -Depth 10
$uri = "$env:SEARCH_ENDPOINT/indexes/loom-governance-items?api-version=2024-07-01"
Invoke-RestMethod -Uri $uri -Method Put -Headers @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' } -Body $body
Write-Output "loom-governance-items index ensured"
'''
  }
}

output searchId string = search.id
output searchName string = search.name
output searchEndpoint string = 'https://${search.name}.search.windows.net'
// System-assigned MSI principal ID — grant Storage Blob Data Contributor on the
// debug-session storage account (done above when debugSessionStorageId is set).
output searchPrincipalId string = search.identity.principalId
