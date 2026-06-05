// CSA Loom — Scale-by-SKU RBAC
//
// The admin console's /admin/scaling (Scale by SKU) surface lets an operator
// change compute SKUs for the resources that live in the admin resource group:
// ADX / Kusto cluster, Synapse dedicated SQL pool (DWU), API Management,
// Container Apps, Fabric / Foundry compute, and AI Search. Each "Apply" is a
// real ARM control-plane PATCH performed AS THE CONSOLE UAMI.
//
// The UAMI's other grants are narrow (per-resource data-plane + RG Reader), so
// without a write role here every scale operation returns 403 ("does not have
// authorization to perform action 'Microsoft.Kusto/clusters/write'", etc.).
// Contributor at RG scope is the admin-plane identity managing its own plane.
//
// Split into its own module (vs. inlined in main.bicep) so the principalId —
// which is a module OUTPUT in main.bicep — is a plain start-time-known param
// here, satisfying the role-assignment name/if requirements (avoids BCP177).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted Contributor on this RG so /admin/scaling can PATCH compute SKUs. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip all role grants (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Contributor — b24988ac-6180-42a0-ab88-20f7382dd24c
resource consoleScalingContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, 'scale-by-sku-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
