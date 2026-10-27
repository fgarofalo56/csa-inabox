// CSA Loom Health Data Services (LHDS) - lets the APIM gateway read the control plane.
//
// The lhds-tenant-routing fragment calls GET /api/health/routing-map on the control
// plane with the APIM managed identity (authentication-managed-identity). This module
// grants that identity Reader on the control-plane resource only (the Container App,
// or the stamp cluster on the aks path), never on the resource group or subscription.
// Reader is the narrowest built-in role that makes the control plane resource visible
// to the gateway identity; the data-plane decision stays with the control plane's own
// token validation (audience and allowed caller app ids).
//
// The APIM service may live in another resource group or subscription. Only its
// system-assigned principal id is read; nothing is written to the APIM service here.
//
// Scope: the stamp resource group. Invoked by health.bicep.

targetScope = 'resourceGroup'

@description('Name of the existing API Management service whose system-assigned identity receives Reader.')
param apimServiceName string

@description('Resource group of the APIM service.')
param apimResourceGroupName string

@description('Subscription of the APIM service.')
param apimSubscriptionId string

@description('Control plane hosting path (control-plane.bicep output platform).')
@allowed(['containerApps', 'aks'])
param platform string

@description('Control plane Container App name (containerApps path).')
param controlPlaneAppName string = 'loom-health-cp'

@description('Stamp cluster name (aks path).')
param aksClusterName string = ''

@description('Skip the role assignment (re-deploys where the deployer cannot write RBAC).')
param skipRoleGrants bool = false

var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var onAks = platform == 'aks'

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimServiceName
  scope: resourceGroup(apimSubscriptionId, apimResourceGroupName)
}

resource cpApp 'Microsoft.App/containerApps@2025-02-02-preview' existing = if (!onAks) {
  name: controlPlaneAppName
}

resource cluster 'Microsoft.ContainerService/managedClusters@2025-04-01' existing = if (onAks) {
  name: aksClusterName
}

// The role-assignment name is derived from ids known at compile time (the APIM
// resource id and the target), not from the runtime principalId.
resource readerOnApp 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!onAks && !skipRoleGrants) {
  scope: cpApp
  name: guid(apim.id, cpApp.id, readerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS: APIM gateway identity reads the control plane routing map.'
  }
}

resource readerOnCluster 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (onAks && !skipRoleGrants) {
  scope: cluster
  name: guid(apim.id, cluster.id, readerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS: APIM gateway identity reads the control plane routing map.'
  }
}

@description('Principal id of the APIM system-assigned identity that was granted Reader.')
output apimPrincipalId string = apim.identity.principalId
