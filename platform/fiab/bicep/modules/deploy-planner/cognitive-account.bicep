// CSA Loom deploy-planner — Azure AI / Cognitive Services account
//
// Reused by several deploy-planner catalog rows (one module, many kinds):
//   - aiServices            → kind 'CognitiveServices'  (multi-service account)
//   - documentIntelligence  → kind 'FormRecognizer'
//   - contentSafety         → kind 'ContentSafety'
//   - visionServices        → kind 'ComputerVision'
//   - speechServices        → kind 'SpeechServices'
//   - languageServices      → kind 'TextAnalytics'      (Language service)
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

@description('Cognitive Services account kind: CognitiveServices (multi), FormRecognizer (Document Intelligence), ContentSafety, ComputerVision (Vision), SpeechServices (Speech), or TextAnalytics (Language).')
@allowed(['CognitiveServices', 'FormRecognizer', 'ContentSafety', 'ComputerVision', 'SpeechServices', 'TextAnalytics'])
param kind string

@description('Short name fragment (e.g. aiservices / docintel / contentsafety) used in the resource name + subdomain.')
param nameFragment string

@description('Account SKU. S0 is the standard pay-as-you-go tier.')
param skuName string = 'S0'

@description('Loom Console UAMI principal ID — granted Cognitive Services User so the BFF can call the data plane token-only. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Also grant the Console UAMI Cognitive Services Contributor (write data-plane). Required for ContentSafety so the BFF can manage custom blocklists (create/delete lists + add/remove items); Cognitive Services User alone is read/analyze-only and returns 403 on blocklist writes. Default false (read-only User grant).')
param grantContributor bool = false

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

// Cognitive Services Contributor — data-plane WRITE access (e.g. Content Safety
// custom-blocklist management). role 25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68.
resource cogContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && grantContributor && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output accountId string = account.id
output accountName string = account.name
output endpoint string = account.properties.endpoint
