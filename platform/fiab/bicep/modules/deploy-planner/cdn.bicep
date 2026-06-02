// CSA Loom deploy-planner — Azure CDN profile
//
// Wired by the deploy-planner catalog (key: cdn → cdnEnabled).
// Self-contained: a single classic CDN profile (Microsoft.Cdn/profiles) using
// the Microsoft-managed provider. Endpoints are created later from the CDN
// navigator against a real origin, so the profile provisions standalone. The
// Loom Console UAMI is granted CDN Profile Contributor so the navigator can
// manage endpoints over ARM.
//
// Grounded in Microsoft Learn:
//   Microsoft.Cdn/profiles (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.cdn/profiles

targetScope = 'resourceGroup'

@description('Primary region (CDN profile metadata region — content is delivered from the global edge).')
param location string

@description('CDN SKU. Standard_Microsoft is the Microsoft-managed classic CDN tier.')
@allowed(['Standard_Microsoft', 'Standard_Akamai', 'Standard_Verizon', 'Premium_Verizon'])
param skuName string = 'Standard_Microsoft'

@description('Loom Console UAMI principal ID — granted CDN Profile Contributor so the BFF can manage endpoints. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var profileName = take('cdn-loom-${uniqueString(resourceGroup().id)}', 64)

resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: profileName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
  }
  properties: {}
}

// CDN Profile Contributor — manage endpoints/origins on the profile
// (role ec156ff8-a8d1-4d15-830c-5b80698ca432).
resource cdnContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: profile
  name: guid(profile.id, consolePrincipalId, 'ec156ff8-a8d1-4d15-830c-5b80698ca432')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ec156ff8-a8d1-4d15-830c-5b80698ca432')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output cdnProfileId string = profile.id
output cdnProfileName string = profile.name
