// CSA Loom deploy-planner — Azure AI / Cognitive Services account
//
// Reused by three deploy-planner catalog rows (one module, three kinds):
//   - aiServices            → kind 'CognitiveServices'  (multi-service account)
//   - documentIntelligence  → kind 'FormRecognizer'
//   - contentSafety         → kind 'ContentSafety'
//
// Self-contained: a single Microsoft.CognitiveServices/accounts resource with
// local auth disabled (Entra-only), a custom subdomain (required for token
// auth), and the Loom Console UAMI granted Cognitive Services User so the BFF
// can call the data plane token-only.
//
// Grounded in Microsoft Learn:
//   Microsoft.CognitiveServices/accounts  (Bicep resource definition)
//   https://learn.microsoft.com/azure/templates/microsoft.cognitiveservices/accounts

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Cognitive Services account kind. CognitiveServices (multi), FormRecognizer (Document Intelligence), or ContentSafety.')
@allowed(['CognitiveServices', 'FormRecognizer', 'ContentSafety'])
param kind string

@description('Short name fragment (e.g. aiservices / docintel / contentsafety) used in the resource name + subdomain.')
param nameFragment string

@description('Account SKU. S0 is the standard pay-as-you-go tier.')
param skuName string = 'S0'

@description('Loom Console UAMI principal ID — granted Cognitive Services User so the BFF can call the data plane token-only. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var accountName = take('cog-${nameFragment}-loom-${uniqueString(resourceGroup().id)}', 64)

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  tags: complianceTags
  kind: kind
  sku: { name: skuName }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
    }
  }
}

// Cognitive Services User — data-plane access token-only
// (role a97b65f3-24c7-4388-baec-2e87135dc908).
resource cogUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, 'a97b65f3-24c7-4388-baec-2e87135dc908')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output accountId string = account.id
output accountName string = account.name
output endpoint string = account.properties.endpoint
