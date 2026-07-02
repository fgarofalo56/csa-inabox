// CSA Loom — Slate-app / Workshop-app Publish → Azure Static Web Apps RBAC.
//
// Grants the Console UAMI "Website Contributor" at the SWA resource-group
// scope so the publish BFF routes
// (app/api/items/{slate-app,workshop-app}/[id]/publish) can:
//   - PUT  Microsoft.Web/staticSites/{name}            (idempotent create/update)
//   - GET  Microsoft.Web/staticSites/{name}            (poll defaultHostname)
//   - POST Microsoft.Web/staticSites/{name}/listSecrets (deployment token)
// in the RG the Console reads from LOOM_SWA_RESOURCE_GROUP (defaults to the
// admin RG; byoExisting.swaResourceGroup / root loomSwaResourceGroup override).
//
// Deployed as an RG-scoped module (not inline) because the target RG can
// differ from the admin RG and cross-RG role assignments cannot be authored
// inline (BCP139) — same pattern as adx-mi-storage-rbac.bicep.
//
// Website Contributor (de139f84-1756-47ae-9be6-808fbbe706ee) is cloud-agnostic
// (identical GUID across Commercial / GCC / GCC-High / IL5) and is the least
// built-in role covering staticSites write + listSecrets — Contributor is NOT
// required. 100% Azure-native (ARM staticSites); no Microsoft Fabric.

targetScope = 'resourceGroup'

@description('Console UAMI principal ID — granted Website Contributor at this RG scope. Empty skips the grant (the publish routes then surface their honest 403 gate naming this role).')
param consolePrincipalId string

@description('When true, skip the role grant (re-deploy where RBAC already exists, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Website Contributor
var websiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbbe706ee'

resource swaWebsiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, websiteContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', websiteContributorRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
