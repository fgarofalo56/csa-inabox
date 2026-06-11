// CSA Loom — Azure Maps account (geoanalytics backing)
//
// Backs the geo-map / geo-dataset / geo-pipeline / geo-query / map editors:
//   - Static-map tile preview for `map` editor (MapEditor)
//   - Vector tile + reverse-geocode rendering for `geo-map` (GeoMapEditor)
//   - Reverse-geocode enrichment for `geo-pipeline` (GeoPipelineEditor)
//
// The S1 SKU supports keyless AAD auth (preferred) AND subscription-key
// auth (used by the static-map iframe today). Both are enabled — the
// Console UAMI gets the `Azure Maps Data Reader` role for AAD calls, and
// the primary key is exported via Key Vault for the SPA preview path.
//
// Per `no-vaporware.md`: this module is the bicep half of the geo family.
// If the resource is not deployed, the GeoMap / GeoPipeline editors show
// the documented MessageBar gates and config-only save still works.

targetScope = 'resourceGroup'

@description('Primary region. Azure Maps accounts are global (`location: global`); kept for parity with other admin-plane modules.')
#disable-next-line no-unused-params
param location string

@description('Cloud boundary — Maps is GA in Commercial, GCC. NOT yet available in GCC-High / IL5; gate the module via the orchestrator.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Azure Maps account SKU. S0/S1 are Gen1 (retirement path); G2 is the Gen2 SKU that matches kind:Gen2 (AVM default) and supports AAD + unlimited TPS.')
@allowed(['S0', 'S1', 'G2'])
param sku string = 'G2'

@description('Console UAMI principal ID — granted Azure Maps Data Reader.')
param consolePrincipalId string

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Key Vault resource ID for storing the primary key (SPA tile preview path).')
param keyVaultId string

@description('Compliance tags')
param complianceTags object

var mapsAccountName = 'maps-csa-loom-${uniqueString(resourceGroup().id)}'

// Azure Maps account
resource mapsAccount 'Microsoft.Maps/accounts@2024-07-01-preview' = if (boundary == 'Commercial' || boundary == 'GCC') {
  name: mapsAccountName
  location: 'global'
  tags: complianceTags
  sku: { name: sku }
  kind: 'Gen2'
  identity: { type: 'SystemAssigned' }
  properties: {
    disableLocalAuth: false                              // SPA preview still needs key auth
    cors: { corsRules: [{ allowedOrigins: ['https://*.b02.azurefd.net'] }] }
    // Atlas is a public-only multi-tenant service — there is no PE for
    // Microsoft.Maps/accounts. `publicNetworkAccess` is NOT a valid
    // property on this resource type (the resource is always public).
  }
}

// Console UAMI → Azure Maps Data Reader on the account
// Role: Azure Maps Data Reader (423170ca-a8f6-4b0f-8487-9e4eb8f49bfa)
resource mapsDataReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if ((boundary == 'Commercial' || boundary == 'GCC') && !empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(mapsAccount.id, consolePrincipalId, '423170ca-a8f6-4b0f-8487-9e4eb8f49bfa')
  scope: mapsAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '423170ca-a8f6-4b0f-8487-9e4eb8f49bfa')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Stash primary key into Key Vault for the SPA preview (NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY).
// Read at deploy time via list-keys; KV value rotates automatically when
// the bicep is re-deployed with a refreshed key. We use a child KV vault
// reference (`existing` lookup against the passed vault ID) so the secret
// is scoped under that vault.
resource keyVault 'Microsoft.KeyVault/vaults@2024-04-01-preview' existing = {
  name: last(split(keyVaultId, '/'))
}

resource mapsKeySecret 'Microsoft.KeyVault/vaults/secrets@2024-04-01-preview' = if (boundary == 'Commercial' || boundary == 'GCC') {
  parent: keyVault
  name: 'loom-azure-maps-primary-key'
  properties: {
    value: (boundary == 'Commercial' || boundary == 'GCC') ? mapsAccount!.listKeys().primaryKey : ''
    contentType: 'azure-maps-primary-key'
    attributes: { enabled: true }
  }
}

// =====================================================================
// Outputs
// =====================================================================

output mapsAccountName string = (boundary == 'Commercial' || boundary == 'GCC') ? mapsAccount!.name : ''
output mapsAccountId string = (boundary == 'Commercial' || boundary == 'GCC') ? mapsAccount!.id : ''
output mapsKeySecretName string = (boundary == 'Commercial' || boundary == 'GCC') ? 'loom-azure-maps-primary-key' : ''
output mapsAvailable bool = boundary == 'Commercial' || boundary == 'GCC'
