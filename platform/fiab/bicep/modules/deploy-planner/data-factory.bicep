// CSA Loom deploy-planner — Azure Data Factory (v2)
//
// Wired by the deploy-planner catalog (key: dataFactory → dataFactoryEnabled).
// Self-contained (no networking deps): one factory with a system-assigned
// identity so the ADF editors (Pipeline / Dataset / Trigger) have a real
// factory to CRUD against. The Loom Console UAMI is granted Data Factory
// Contributor on the factory.
//
// (The DLZ already has a private-link ADF module at modules/landing-zone/adf.bicep;
// this lean variant is the deploy-planner toggle that stands alone in the
// admin-plane RG with no spoke-VNet dependency.)
//
// Grounded in Microsoft Learn:
//   Microsoft.DataFactory/factories  (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.datafactory/factories

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Console UAMI principal ID — granted Data Factory Contributor so the BFF can CRUD pipelines/datasets/triggers. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var factoryName = take('adf-loom-${uniqueString(resourceGroup().id)}', 63)

resource adf 'Microsoft.DataFactory/factories@2018-06-01' = {
  name: factoryName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    publicNetworkAccess: 'Enabled'
  }
}

// Data Factory Contributor — CRUD pipelines/datasets/triggers + run
// (role 673868aa-7521-48a0-acc6-0f60742d39f5).
resource adfContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: adf
  name: guid(adf.id, consolePrincipalId, '673868aa-7521-48a0-acc6-0f60742d39f5')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '673868aa-7521-48a0-acc6-0f60742d39f5')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output factoryId string = adf.id
output factoryName string = adf.name
