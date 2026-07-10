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
// Website Contributor (de139f84-1756-47ae-9be6-808fbbe706ee) is the least built-in
// role covering staticSites write + listSecrets on Commercial / GCC — Contributor
// is NOT required there. It does NOT resolve in Azure Government, though: a LIVE
// `az deployment sub create` into usgovvirginia (2026-07-10) failed this
// assignment with `RoleDefinitionDoesNotExist: de139f84175647ae9be6808fbbe706ee`.
// So on GCC-High / IL5 this module falls back to Contributor (which exists in
// every cloud) — the narrowest built-in available in Gov that still covers the
// staticSites write + listSecrets the publish routes need. 100% Azure-native (ARM
// staticSites); no Microsoft Fabric.

targetScope = 'resourceGroup'

@description('Console UAMI principal ID — granted the SWA publish role at this RG scope. Empty skips the grant (the publish routes then surface their honest 403 gate naming this role).')
param consolePrincipalId string

@description('Cloud boundary — selects a role definition that exists in the target cloud. Website Contributor (used on Commercial / GCC) does not resolve in Azure Government, so GCC-High / IL5 use Contributor instead. Defaults to Commercial for backward compatibility.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string = 'Commercial'

@description('When true, skip the role grant (re-deploy where RBAC already exists, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Website Contributor — Commercial / GCC least-privilege for staticSites.
var websiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbbe706ee'
// Contributor — the Azure Government fallback (Website Contributor is absent there;
// see header). Broader than Website Contributor but the narrowest built-in that
// exists in Gov and covers Microsoft.Web/staticSites write + listSecrets.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
// GCC-High / IL5 are the sovereign (Azure Government) boundaries; GCC (moderate)
// runs in commercial Azure and keeps the Commercial role.
var effectiveSwaRoleId = (boundary == 'GCC-High' || boundary == 'IL5') ? contributorRoleId : websiteContributorRoleId
// In Gov the fallback role IS Contributor — which the core RBAC grants already
// assign to the Console UAMI at this RG scope, so creating it here duplicates
// the (scope, principal, role) triple under a new name and ARM rejects it
// (LIVE: RoleAssignmentExists, usgovvirginia 2026-07-10 round 2). Skip in the
// sovereign boundaries: the publish permission is already covered.
var sovereignRedundant = (boundary == 'GCC-High' || boundary == 'IL5')

resource swaWebsiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants && !sovereignRedundant) {
  name: guid(resourceGroup().id, consolePrincipalId, effectiveSwaRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', effectiveSwaRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
