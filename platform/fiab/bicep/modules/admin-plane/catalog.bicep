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
// Databricks UC scan credential Key Vault (OPT-IN — PAT alternative)
//
// The DEFAULT Databricks Unity Catalog scan path is MI-first: the Purview
// account's system-assigned managed identity (above) is registered as a
// Databricks service principal and granted UC SELECT/USE privileges — that path
// needs NO Key Vault. This Key Vault exists only for operators who prefer the
// Access-Token (PAT) auth method, where a Databricks personal access token is
// stored as a Key Vault secret and surfaced to Purview as an Access-Token
// credential. Per Microsoft Learn the Purview account MSI must be granted access
// to read the Key Vault secret:
//   https://learn.microsoft.com/purview/data-map-data-scan-credentials#grant-microsoft-purview-access-to-your-azure-key-vault
//
// Provisioned EMPTY (no secret in bicep — secrets never live in templates). The
// operator/bootstrap adds the PAT secret and creates the Purview Key Vault
// connection + credential post-deploy via
// scripts/csa-loom/setup-purview-databricks-scan.sh (PAT mode).
// =====================================================================

@description('Opt-in: provision a Key Vault for the Databricks UC scan Access-Token (PAT) credential. Leave false to use the MI-first scan path (no Key Vault).')
param databricksScanKeyVaultEnabled bool = false

@description('Key Vault name for the Databricks UC scan PAT secret (PAT mode only). 3-24 chars, globally unique.')
@minLength(3)
@maxLength(24)
param databricksScanKeyVaultName string = take('kvloomdbx${uniqueString(resourceGroup().id)}', 24)

resource dbxScanKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' = if (purviewEnabled && databricksScanKeyVaultEnabled) {
  name: databricksScanKeyVaultName
  location: location
  tags: complianceTags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

// Grant the Purview account's system-assigned MI "Key Vault Secrets User" so it
// can read the Databricks PAT secret when the Access-Token credential resolves.
resource dbxScanKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (purviewEnabled && databricksScanKeyVaultEnabled && !skipRoleGrants) {
  scope: dbxScanKeyVault
  name: guid(dbxScanKeyVault.id, purview.id, '4633458b-17de-408a-b874-0445c86b69e6')
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
    principalId: purviewEnabled ? purview.identity.principalId : ''
    principalType: 'ServicePrincipal'
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

// ADLS Gen2 (DFS) endpoint for the domain-images container — consumed by
// main.bicep → LOOM_DOMAIN_IMAGE_STORAGE. The images BFF route lists gallery
// blobs via the DataLakeServiceClient, which targets the `.dfs.` host and the
// container path (the `.blob.` endpoint above is kept for callers that want the
// plain blob host). DFS listing works on a flat StorageV2 account — Hierarchical
// Namespace is NOT required. '' when Purview/catalog storage is not deployed, so
// the editor falls back to preset swatches/icons and shows the honest gate.
output domainImagesDfsContainerUrl string = purviewEnabled
  ? 'https://${domainImagesStorage.name}.dfs.core.${boundary == 'GCC-High' || boundary == 'IL5' ? 'usgovcloudapi.net' : 'windows.net'}/domain-images'
  : ''

// Post-deploy reminder: mirroring a Loom domain to a Purview classic COLLECTION
// (create/update/delete via PUT/DELETE /collections) requires the Console UAMI
// to hold the "Collection Admin" Data Map role on the root collection. Like the
// data-reader grant above this is a data-plane metadata-policy role (NOT ARM
// RBAC), so it is applied post-deploy by csa-loom-post-deploy-bootstrap.yml via
// scripts/csa-loom/grant-purview-datamap-role.sh (ROLE=collection-administrator).
output consolePurviewCollectionAdminGrant string = purviewEnabled && !empty(consolePrincipalId)
  ? 'Post-deploy: ROLE=collection-administrator CONSOLE_UAMI_PRINCIPAL=${consolePrincipalId} PURVIEW_ACCOUNT=${purview.name} bash scripts/csa-loom/grant-purview-datamap-role.sh'
  : ''

// Post-deploy reminder: pushing the Loom classification taxonomy into Purview
// as REAL custom classification rules + CUSTOM scan rule sets and TRIGGERING
// scans (the /admin/classifications surface + /api/governance/scans) requires
// the Console UAMI to hold the "Data Source Administrator" Data Map role on the
// root collection — register/update data sources, create classification rules,
// create scan rule sets, define + run scans. Like the grants above this is a
// data-plane metadata-policy role (NOT ARM RBAC), applied post-deploy by
// csa-loom-post-deploy-bootstrap.yml via grant-purview-datamap-role.sh
// (ROLE=data-source-administrator). When LOOM_PURVIEW_ACCOUNT is unset the
// classifications surface still works (rules saved to Cosmos) and renders an
// honest gate naming this env var.
output consolePurviewScanAdminGrant string = purviewEnabled && !empty(consolePrincipalId)
  ? 'Post-deploy: ROLE=data-source-administrator CONSOLE_UAMI_PRINCIPAL=${consolePrincipalId} PURVIEW_ACCOUNT=${purview.name} bash scripts/csa-loom/grant-purview-datamap-role.sh'
  : ''

// Databricks UC scan credential Key Vault (PAT-mode alternative). '' when the
// MI-first default path is used (databricksScanKeyVaultEnabled=false).
output dbxScanKeyVaultName string = purviewEnabled && databricksScanKeyVaultEnabled ? dbxScanKeyVault.name : ''
output dbxScanKeyVaultUri string = purviewEnabled && databricksScanKeyVaultEnabled ? dbxScanKeyVault.properties.vaultUri : ''

// Post-deploy reminder: enabling the Databricks UC SCAN (catalog metadata) on
// the catalog-metastores surface. The DEFAULT path is MI-first — register the
// Purview account's system-assigned managed identity as a Databricks service
// principal and grant it UC SELECT/USE privileges; no Key Vault is needed. The
// PAT alternative stores a Databricks personal access token in the Key Vault
// above and creates a Purview Key Vault connection + Access-Token credential.
// Both are data-plane operations (NOT ARM), so they run post-deploy via the
// bootstrap script. Lineage additionally needs system.access enabled in UC.
output consolePurviewDatabricksScanSetup string = purviewEnabled
  ? 'Post-deploy (MI-first): PURVIEW_ACCOUNT=${purview.name} PURVIEW_APP_ID=${purview.identity.principalId} bash scripts/csa-loom/setup-purview-databricks-scan.sh  # PAT mode: add MODE=pat KEYVAULT=${databricksScanKeyVaultEnabled ? dbxScanKeyVault.name : '<kv>'}'
  : ''
