// CSA Loom deploy-planner — Azure AI / Cognitive Services account
//
// Reused by several deploy-planner catalog rows (one module, many kinds):
//   - aiServices            → kind 'CognitiveServices'  (multi-service account)
//   - documentIntelligence  → kind 'FormRecognizer'
//   - contentSafety         → kind 'ContentSafety'
//   - visionServices        → kind 'ComputerVision'
//   - speechServices        → kind 'SpeechServices'
//   - languageServices      → kind 'TextAnalytics'      (Language service)
//   - translator            → kind 'TextTranslation'    (Translator service, SVC-1)
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

@description('Cognitive Services account kind: CognitiveServices (multi), FormRecognizer (Document Intelligence), ContentSafety, ComputerVision (Vision), SpeechServices (Speech), TextAnalytics (Language), or TextTranslation (Translator).')
@allowed(['CognitiveServices', 'FormRecognizer', 'ContentSafety', 'ComputerVision', 'SpeechServices', 'TextAnalytics', 'TextTranslation'])
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

@description('Deny public network access (publicNetworkAccess=Disabled) — reachable only over a private endpoint. Default false: this opt-in deploy-planner sandbox service is provisioned with no private-endpoint wiring, so it stays publicly reachable behind Entra-only auth. Set true after wiring a private endpoint to harden. Derivation mirrors admin-plane/ai-foundry.bicep.')
param privateEndpointsEnabled bool = false

var effectivePublicNetworkAccess = privateEndpointsEnabled ? 'Disabled' : 'Enabled'

@description('Hub private-endpoint subnet. When supplied together with privateDnsZoneCognitiveServicesId a private endpoint is created for this account and registered in privatelink.cognitiveservices.*, so the account resolves to a VNet-internal address from the Console. Empty (default) = no private endpoint.')
param privateEndpointSubnetId string = ''

@description('Resource id of the privatelink.cognitiveservices.azure.{com|us} private DNS zone the private endpoint registers its A record in. Empty = no private endpoint.')
param privateDnsZoneCognitiveServicesId string = ''

var deployPrivateEndpoint = !empty(privateEndpointSubnetId) && !empty(privateDnsZoneCognitiveServicesId)

// ---------------------------------------------------------------------------
// Private endpoint — #4432.
//
// A Cognitive Services account with publicNetworkAccess=Enabled is reachable
// from the INTERNET, which is not the same thing as reachable from the Loom
// VNet. Measured on the live Commercial estate 2026-09-10, from inside the
// loom-console container:
//
//   cog-contentsafety-*.cognitiveservices.azure.com   => ENOTFOUND
//   hzd9c4bdb9e4fng6.ai-gateway.dm1-02.azure-api.net  => ENOTFOUND
//   apim-csa-loom-centralus.azure-api.net             => 10.0.4.4
//   www.microsoft.com                                 => 173.223.1.196
//
// Azure fronts these regional Cognitive Services endpoints with a public CNAME
// chain that traverses `*.azure-api.net`. Loom links a PRIVATE DNS zone named
// `azure-api.net` to the hub VNet for the Loom APIM private endpoint, and a
// linked private zone is AUTHORITATIVE for its entire namespace — so every
// `*.azure-api.net` name that is not in the zone answers NXDOMAIN inside the
// VNet instead of falling through to public DNS. The CNAME chain dies at that
// first hop and the account's hostname does not resolve at all.
//
// Consequence: LOOM_CONTENT_SAFETY_ENDPOINT was wired, `isSafetyConfigured()`
// was true, and every Copilot turn tried to screen its prompt against a host
// that could not be resolved. Chat 500'd until the client was taught to fail
// open — and once it fails open, moderation is silently OFF.
//
// Per .claude/rules/auto-bind-by-default.md §5 the platform must DEPLOY the
// binding rather than ask for it: give the account a private endpoint and an A
// record in privatelink.cognitiveservices.*, exactly as the AOAI / AI Foundry
// accounts already have, so the name resolves to a VNet address and never
// touches the shadowed `azure-api.net` namespace.
// ---------------------------------------------------------------------------
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployPrivateEndpoint) {
  name: 'pe-${accountName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${accountName}'
        properties: {
          privateLinkServiceId: account.id
          groupIds: ['account']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployPrivateEndpoint) {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'cognitiveservices', properties: { privateDnsZoneId: privateDnsZoneCognitiveServicesId } }
    ]
  }
}

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
    publicNetworkAccess: effectivePublicNetworkAccess
    networkAcls: {
      defaultAction: privateEndpointsEnabled ? 'Deny' : 'Allow'
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
