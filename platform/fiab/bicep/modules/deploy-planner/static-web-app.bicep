// CSA Loom deploy-planner — Azure Static Web Apps
//
// Wired by the deploy-planner catalog (key: staticWebApps → staticWebAppsEnabled).
// Self-contained: a single Static Web App (Microsoft.Web/staticSites) with no
// repository link (so it provisions standalone, ready to wire a deployment
// source later) and a system-assigned identity. The Loom Console UAMI is
// granted Website Contributor so the SWA navigator can manage it over ARM.
//
// Grounded in Microsoft Learn:
//   Microsoft.Web/staticSites (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.web/staticsites

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Static Web App SKU. Free is the cheapest functional tier; Standard adds custom auth / SLA.')
@allowed(['Free', 'Standard'])
param skuName string = 'Standard'

@description('Loom Console UAMI principal ID — granted Website Contributor so the BFF can manage the SWA. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var siteName = take('swa-loom-${uniqueString(resourceGroup().id)}', 60)

resource swa 'Microsoft.Web/staticSites@2024-04-01' = {
  name: siteName
  location: location
  tags: complianceTags
  sku: {
    name: skuName
    tier: skuName
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    // No repository link → provisions standalone; a deployment source can be
    // connected later from the SWA navigator.
    allowConfigFileUpdates: true
    stagingEnvironmentPolicy: 'Enabled'
    publicNetworkAccess: 'Enabled'
  }
}

// Website Contributor — ARM management of the static web app
// (role de139f84-1756-47ae-9be6-808fbbe84772).
resource websiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: swa
  name: guid(swa.id, consolePrincipalId, 'de139f84-1756-47ae-9be6-808fbbe84772')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output staticSiteId string = swa.id
output staticSiteName string = swa.name
output defaultHostname string = swa.properties.defaultHostname
