// CSA Loom deploy-planner — Azure Functions (Consumption plan, Linux)
//
// Wired by the deploy-planner catalog (key: functions → functionsEnabled).
// Self-contained: a backing Storage account (required by the Functions
// runtime), a Consumption (Y1 Dynamic) Linux plan, and a function app with
// HTTPS-only + TLS 1.2 + system-assigned identity. The Loom Console UAMI is
// granted Website Contributor.
//
// Grounded in Microsoft Learn:
//   Functions infra-as-code (serverfarms Y1/Dynamic) + Microsoft.Web/sites
//   https://learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Functions runtime stack (node, python, dotnet-isolated, etc.).')
@allowed(['node', 'python', 'dotnet-isolated', 'java'])
param functionsWorkerRuntime string = 'node'

@description('Linux runtime version string (e.g. Node|20, Python|3.12).')
param linuxFxVersion string = 'Node|20'

@description('Loom Console UAMI principal ID — granted Website Contributor so the BFF can manage the function app. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var saName = take('safuncloom${uniqueString(resourceGroup().id)}', 24)
var planName = take('plan-func-loom-${uniqueString(resourceGroup().id)}', 40)
var siteName = take('func-loom-${uniqueString(resourceGroup().id)}', 60)

// Functions runtime requires a backing Storage account. Shared-key access is
// kept on here because the Consumption host's content share (AzureWebJobsStorage)
// uses a connection string; the account is otherwise locked down (no public blob,
// TLS 1.2, HTTPS only).
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: complianceTags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  kind: 'functionapp,linux'
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  tags: complianceTags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${sa.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${sa.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: functionsWorkerRuntime
        }
      ]
    }
  }
}

// Website Contributor — ARM management of the function app
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

output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
