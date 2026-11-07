// CSA Loom Health Data Services (LHDS) - management-plane Reader for the APIM identity.
//
// This grants the APIM system-assigned identity the built-in Reader role on the
// control-plane resource only (the Container App, or the stamp cluster on the aks
// path), never on the resource group or subscription. Reader is an Azure
// MANAGEMENT-plane role. It does NOT authorize the routing-map call the
// lhds-tenant-routing fragment makes (GET /api/health/routing-map).
//
// REMAINING PREREQUISITES for that call (NOT wired here): the control plane authorizes
// it from the token (apps/loom-health-cp/src/middleware/auth.ts) by (1) the app role
// HealthCP.Reader (or HealthCP.Admin) assigned to the APIM identity on the control-plane
// app registration, and (2) when LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS is non-empty, the
// APIM identity's application id being in controlPlaneConfig.allowedCallerAppIds.
// Without both the gateway receives 403 on the routing map.
//
// PRECONDITION: the APIM service must have a SYSTEM-ASSIGNED managed identity enabled.
// Without it `apim.identity.principalId` below fails the deployment; enable it first
// (identity.type SystemAssigned on the APIM service).
//
// The APIM service may live in another resource group or subscription. Only its
// system-assigned principal id is read; nothing is written to the APIM service here.
//
// Scope: the stamp resource group. Invoked by health.bicep.

targetScope = 'resourceGroup'

@description('Name of the existing API Management service whose system-assigned identity receives Reader. The service MUST have a system-assigned identity enabled or the deployment fails on identity.principalId.')
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
    description: 'LHDS: management-plane Reader for the APIM gateway identity on the control plane. Does not authorize the routing-map call.'
  }
}

resource readerOnCluster 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (onAks && !skipRoleGrants) {
  scope: cluster
  name: guid(apim.id, cluster.id, readerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: apim.identity.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS: management-plane Reader for the APIM gateway identity on the control plane. Does not authorize the routing-map call.'
  }
}

@description('Principal id of the APIM system-assigned identity that was granted Reader.')
output apimPrincipalId string = apim.identity.principalId
