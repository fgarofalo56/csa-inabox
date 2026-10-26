// CSA Loom Health Data Services (LHDS) - AcrPull grant on a registry that lives in
// another resource group (the hub). A role assignment cannot cross resource-group
// scope from control-plane.bicep (BCP139), so it is deployed as this module at the
// registry's resource group.

targetScope = 'resourceGroup'

@description('Name of the registry in this resource group.')
param acrName string

@description('Principal granted AcrPull.')
param principalId string

@description('Skip the grant (re-deploys where the deployer cannot write RBAC).')
param skipRoleGrants bool = false

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acr 'Microsoft.ContainerRegistry/registries@2025-04-01' existing = {
  name: acrName
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: acr
  name: guid(acr.id, principalId, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
