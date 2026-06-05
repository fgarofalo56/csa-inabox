// CSA Loom deploy-planner — Azure App Service (Linux web app)
//
// Wired by the deploy-planner catalog (key: appService → appServiceEnabled).
// Self-contained: a Linux App Service plan (B1) + a web app with HTTPS-only,
// FTP disabled, TLS 1.2 minimum, and a system-assigned identity. The Loom
// Console UAMI is granted Website Contributor so the BFF can manage the app.
//
// Grounded in Microsoft Learn:
//   Microsoft.Web/serverfarms + Microsoft.Web/sites  (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.web/sites

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('App Service plan SKU. B1 is the cheapest functional Linux dedicated tier.')
@allowed(['B1', 'B2', 'S1', 'P0v3', 'P1v3'])
param planSku string = 'B1'

@description('Linux runtime stack for the web app (NODE|20-lts, DOTNETCORE|8.0, PYTHON|3.12, etc.).')
param linuxFxVersion string = 'NODE|20-lts'

@description('Loom Console UAMI principal ID — granted Website Contributor so the BFF can manage the app. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var planName = take('plan-loom-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('app-loom-${uniqueString(resourceGroup().id)}', 60)

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: complianceTags
  sku: { name: planSku }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
    }
  }
}

// Website Contributor — ARM management of the web app
// (role de139f84-1756-47ae-9be6-808fbbe84772).
resource websiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: site
  name: guid(site.id, consolePrincipalId, 'de139f84-1756-47ae-9be6-808fbbe84772')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output planId string = plan.id
output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
