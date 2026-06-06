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
