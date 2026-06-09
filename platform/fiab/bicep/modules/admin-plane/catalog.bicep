// CSA Loom — Catalog dispatcher (PRP-12)
// Per LD-8 + per-boundary defaults:
//   Commercial:  Databricks UC managed + Purview overlay
//   GCC:         Databricks UC managed + Purview overlay
//   GCC-High:    Purview primary (UC not GA in usgovaz/va)
//   IL5:         Apache Atlas on AKS (Purview not in IL5 audit scope)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cloud boundary')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Catalog primary backend')
@allowed(['unity-catalog-managed', 'purview', 'atlas-aks'])
param catalogPrimary string

@description('Purview Data Map availability')
param purviewEnabled bool

@description('Atlas on AKS deployment')
param atlasOnAksEnabled bool

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Console UAMI principal (object) id. Used post-deploy to grant the Console its Purview Data Map "Data Reader" role on the root collection so the lakehouse download proxy can read the MIP sensitivity label scanned onto an ADLS path (F5). Classic Data Map roles are data-plane (collection metadata policy), NOT ARM RBAC, so the grant runs in csa-loom-post-deploy-bootstrap.yml via scripts/csa-loom/grant-purview-datamap-role.sh — this param only flows the principal id through for that step.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Private endpoint subnet ID. Reserved for v3.x — Purview private endpoint wiring is deferred; today catalog uses managed endpoints.')
#disable-next-line no-unused-params
param privateEndpointSubnetId string

@description('AKS cluster ID (required if atlasOnAksEnabled)')
param aksClusterId string = ''

@description('Compliance tags')
param complianceTags object

// =====================================================================
// Microsoft Purview Data Map
// =====================================================================

resource purview 'Microsoft.Purview/accounts@2024-04-01-preview' = if (purviewEnabled) {
  name: 'purview-csa-loom-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  sku: {
    name: 'Standard'
    capacity: 4
  }
  properties: {
    managedResourceGroupName: 'rg-mng-purview-csa-loom-${location}'
    publicNetworkAccess: 'Disabled'
    managedEventHubState: 'Enabled'
  }
}

resource purviewAdminRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (purviewEnabled && !skipRoleGrants) {
  scope: purview
  name: guid(purview.id, adminEntraGroupId, '8a3c2885-9b38-4fd2-9d99-91af537c1347')
  properties: {
    // Purview Data Curator role
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '8a3c2885-9b38-4fd2-9d99-91af537c1347')
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

// =====================================================================
// Apache Atlas on AKS — IL5 only
// =====================================================================

resource atlasNamespace 'Microsoft.ContainerService/managedClusters/namespaces@2025-04-01' = if (atlasOnAksEnabled && !empty(aksClusterId)) {
  // Note: AKS namespace as a top-level ARM resource is preview-only.
  // Production uses Flux/GitOps to apply k8s manifests; this Bicep
  // resource at minimum creates the namespace + RBAC so the GitOps
  // workflow has a target.
  name: '${split(aksClusterId, '/')[8]}/atlas-csa-loom'
  properties: {
    metadata: {
      labels: {
        'csa-loom': 'catalog-primary'
      }
    }
  }
}

// =====================================================================
// Domain Images — Azure Blob Storage (F4 domain gallery)
//
// Per-cloud blob endpoint:
//   Commercial / GCC:  https://{acct}.blob.core.windows.net
//   GCC-High / IL5:    https://{acct}.blob.core.usgovcloudapi.net
//
// UAMI grant: Storage Blob Data Reader (2a2b9908-...) so the Console can
// read/list domain gallery images (the F4 Governance Domains editor offers an
// icon/image gallery). The UAMI must already exist at deploy time (from the
// identity module). Grant is skipped when consolePrincipalId is empty or
// skipRoleGrants is true. Storage is deployed whenever purviewEnabled is true;
// at IL5 (Atlas primary) pass domainImagesEnabled if image storage is still
// wanted — it is gated on purviewEnabled here to avoid an always-on account.
// =====================================================================

@description('Storage account name for F4 domain gallery images. Globally unique, <=24 chars. Defaults to a stable hash of the resource group id.')
@minLength(3)
@maxLength(24)
param domainImagesStorageName string = 'stloomdomimg${take(uniqueString(resourceGroup().id), 8)}'

resource domainImagesStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (purviewEnabled) {
  name: take(domainImagesStorageName, 24)
  location: location
  tags: complianceTags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource domainImagesBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (purviewEnabled) {
  parent: domainImagesStorage
  name: 'default'
}

resource domainImagesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (purviewEnabled) {
  parent: domainImagesBlobService
  name: 'domain-images'
  properties: { publicAccess: 'None' }
}

// Storage Blob Data Reader for the Console UAMI — lets the BFF read/list gallery blobs.
resource domainImagesReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (purviewEnabled && !empty(consolePrincipalId) && !skipRoleGrants) {
  scope: domainImagesStorage
  name: guid(domainImagesStorage.id, consolePrincipalId, '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1') // Storage Blob Data Reader
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// =====================================================================
// Outputs — caller uses these to wire DLZ catalog endpoints
// =====================================================================

output catalogKind string = catalogPrimary
output purviewAccountId string = purviewEnabled ? purview.id : ''
output purviewAccountName string = purviewEnabled ? purview.name : ''
output purviewEndpoint string = purviewEnabled
  ? 'https://${purview.name}.purview.azure.${boundary == 'GCC-High' || boundary == 'IL5' ? 'us' : 'com'}'
  : ''

// Atlas endpoint resolved via the GitOps deployment in a follow-on
// run; placeholder here so the orchestrator surfaces a stable URL
// once the deployment completes
output atlasEndpoint string = atlasOnAksEnabled
  ? 'https://atlas.csa-loom-aks.${location}.internal'
  : ''

// Post-deploy reminder: the Console UAMI (consolePrincipalId) must hold a
// Purview Data Map "Data Reader" role on the root collection for the F5
// MIP-label-on-download lookup. Surfaced as an output because classic Data Map
// roles cannot be assigned in ARM/Bicep (they are collection metadata-policy /
// data-plane). The bootstrap workflow performs the grant.
output consolePurviewRoleGrant string = purviewEnabled && !empty(consolePrincipalId)
  ? 'Post-deploy: ROLE=data-reader CONSOLE_UAMI_PRINCIPAL=${consolePrincipalId} PURVIEW_ACCOUNT=${purview.name} bash scripts/csa-loom/grant-purview-datamap-role.sh'
  : ''

// F19 Audit logs: the Purview Data Map /datamap/api/audit/query endpoint
// (api-version 2023-10-01-preview) is on the same data-plane scope as the F5
// MIP-label lookup above. The Console UAMI needs at minimum "Data Reader" on the
// root collection to read audit history; "Data Curator" / "Data Source
// Administrator" (granted by the same script) are supersets and also sufficient.
// No additional ARM role assignment is needed — classic Data Map roles are
// collection metadata-policy and the bootstrap workflow performs the grant.
output consolePurviewAuditNote string = purviewEnabled && !empty(consolePrincipalId)
  ? 'F19 audit read: Loom UAMI needs "Data Reader" (minimum) on the root collection for /datamap/api/audit/query. Granted by grant-purview-datamap-role.sh (ROLE=data-reader). When LOOM_PURVIEW_ACCOUNT is unset the audit grid falls back to Cosmos + Log Analytics sources and renders an honest gate.'
  : ''

// F4 domain-image gallery storage — consumed by main.bicep → LOOM_DOMAIN_IMAGES_URL.
output domainImagesStorageId string = purviewEnabled ? domainImagesStorage.id : ''
output domainImagesEndpoint string = purviewEnabled
  ? 'https://${domainImagesStorage.name}.blob.core.${boundary == 'GCC-High' || boundary == 'IL5' ? 'usgovcloudapi.net' : 'windows.net'}'
  : ''
