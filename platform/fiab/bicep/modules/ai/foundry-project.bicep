// CSA Loom — AI Foundry (AIServices) account + Agent Service project + models
// =============================================================================
// Encodes the LIVE Commercial deployment one-for-one so a fresh `az deployment`
// reproduces it (no-vaporware bicep-sync requirement). This is the DEDICATED
// Foundry Agent Service account the Console BFF targets via
// LOOM_FOUNDRY_PROJECT_ENDPOINT — distinct from the shared AzureML Foundry Hub
// in ../admin-plane/ai-foundry.bicep.
//
// Live mapping (sub <YOUR_SUBSCRIPTION_ID>, rg-csa-loom-admin-eastus2):
//   account  : aifndry-loom-eastus2  (Microsoft.CognitiveServices/accounts kind=AIServices, S0, custom domain)
//   project  : loom-agents           (accounts/projects, 2025-04-01-preview, SystemAssigned)
//   model #1 : chat                  = gpt-4.1 v2025-04-14        (GlobalStandard) — the "standard" tier
//   model #2 : embed                 = text-embedding-3-large v1  (GlobalStandard) — matches the aoai-chat-client default
//   model #3 : mini                  = gpt-4.1-mini v2025-04-14   (GlobalStandard) — the "mini" tier (cheap/lightweight turns)
//   model #4 : strong                = gpt-4.1 v2025-04-14        (GlobalStandard) — the "strong" tier (reasoning turns)
//   grants   : Console UAMI -> Azure AI Developer
//                              Cognitive Services User
//                              Cognitive Services OpenAI User   (account scope)
//
// MODEL-STRATEGY (AIF-12 / model-strategy M2): the chat/mini/strong slots are
// the deployment targets the Loom-native model TIER ROUTER routes to
// (lib/foundry/model-tier-router.ts) — lightweight->mini, general->standard(chat),
// reasoning->strong. Model NAMES + versions are PARAMETERIZED with GA-safe
// defaults (gpt-4.1 / gpt-4.1-mini, both GA in Commercial AND Azure Government
// Standard). Operators RAISE them to gpt-5.x / gpt-5.6 where regionally
// available via the *ModelName / *ModelVersion params (or admin-plane boundary
// overrides) — never hard-coded to a model that could 404.
// =============================================================================

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('AIServices (AI Foundry) account name. Live: aifndry-loom-<location>.')
param accountName string = 'aifndry-loom-${location}'

@description('Custom subdomain for the account (required for token auth + project endpoints). Defaults to the account name.')
param customSubDomainName string = accountName

@description('Foundry Agent Service project name (child of the account). Live: loom-agents.')
param projectName string = 'loom-agents'

@description('Project display name shown in the Foundry portal.')
param projectDisplayName string = 'CSA Loom Agents'

@description('Allow public network access to the account. Set false in sovereign / private-only boundaries (then the account is reached over its private endpoint).')
param publicNetworkAccess bool = true

@description('Disable local (key-based) auth. Keep false so the BFF can read keys for AOAI clients; set true to force AAD-only.')
param disableLocalAuth bool = false

// --- Private endpoint (Gap C) ----------------------------------------------
// When publicNetworkAccess is false (sovereign / private-only boundaries) the
// account is reached over a private endpoint. Pass the hub PE subnet + the
// privatelink.openai / privatelink.cognitiveservices zone ids so the A-record
// resolves inside the hub VNet. Empty subnet => no PE (Commercial default keeps
// public access on, so day-one still works without VNet plumbing).
@description('Private-endpoint subnet resource id (network.outputs.privateEndpointsSubnetId). Empty = no private endpoint (public-access boundaries).')
param privateEndpointSubnetId string = ''

@description('privatelink.openai.azure.<suffix> private DNS zone id (network.outputs.privateDnsZoneIds.openai). Empty skips that zone group.')
param privateDnsZoneOpenAiId string = ''

@description('privatelink.cognitiveservices.azure.<suffix> private DNS zone id (network.outputs.privateDnsZoneIds.cognitiveservices). Empty skips that zone group.')
param privateDnsZoneCognitiveServicesId string = ''

// --- Chat model deployment (the "standard" tier the router routes general turns to) ---
@description('Chat deployment name (LOOM_AOAI_CHAT_DEPLOYMENT / LOOM_AOAI_DEPLOYMENT). The model tier router\'s "standard" tier.')
param chatDeploymentName string = 'chat'

@description('Chat model name. Default gpt-4.1 — a current GA model available in Commercial AND Azure Government Standard, and the gpt-4o-class model the Copilot / data-agent / AI-functions honest gates ask for. Operators RAISE to gpt-5.x / gpt-5.6 where regionally available (admin-plane also flips this per boundary). Never hard-code a model that could 404.')
param chatModelName string = 'gpt-4.1'

@description('Chat model version. 2025-04-14 is the current GA gpt-4.1 version (Commercial + Azure Government). Override per boundary if the region pins a different GA version, or when raising to a gpt-5.x model.')
param chatModelVersion string = '2025-04-14'

@description('Chat deployment SKU (GlobalStandard in Commercial; admin-plane flips to Standard in Azure Government where GlobalStandard is unavailable).')
param chatModelSkuName string = 'GlobalStandard'

@description('Chat deployment capacity (thousands of TPM). Default 50 (50K TPM) — well above the legacy 10K so the tier router\'s standard turns have headroom. Tune per quota.')
@minValue(1)
param chatModelCapacity int = 50

// --- Embedding model deployment --------------------------------------------
@description('Embedding deployment name (LOOM_AOAI_EMBED_DEPLOYMENT). Model-agnostic slot name so the underlying model can be upgraded without renaming the deployment.')
param embedDeploymentName string = 'embed'

@description('Embedding model name. Default text-embedding-3-large — a current, higher-quality (3072-dim) embedding model that matches the aoai-chat-client aoaiEmbed() default. Available in Commercial + Azure Government usgovarizona Standard. Admin-plane keeps Gov (GCC-High/IL5) on text-embedding-ada-002 v2 (universally available across Gov regions incl. usgovvirginia).')
param embedModelName string = 'text-embedding-3-large'

@description('Embedding model version. text-embedding-3-large is version 1.')
param embedModelVersion string = '1'

@description('Embedding deployment SKU. GlobalStandard (not regional Standard) so the deploy succeeds in regions where the embedding model has NO regional Standard capacity — e.g. centralus, which only offers GlobalStandard for both gpt-4o AND the embedding models. Matches chatModelSkuName. Override per boundary only if a region requires a different capacity type.')
param embedModelSkuName string = 'GlobalStandard'

@description('Embedding deployment capacity (thousands of TPM).')
@minValue(1)
param embedModelCapacity int = 10

// --- Mini model deployment (the "mini" tier — cheap / lightweight turns) ----
// The Loom-native model tier router routes lightweight task classes (short
// lookups / classification / greetings) to this cheaper/faster slot.
@description('Mini deployment name (LOOM_AOAI_MINI_DEPLOYMENT). The model tier router\'s "mini" tier.')
param miniDeploymentName string = 'mini'

@description('Mini model name. Default gpt-4.1-mini — a current GA cheap/fast model available in Commercial AND Azure Government Standard (usgovarizona + usgovvirginia). Operators RAISE to gpt-5-mini / gpt-5.x-mini where regionally available.')
param miniModelName string = 'gpt-4.1-mini'

@description('Mini model version. 2025-04-14 is the current GA gpt-4.1-mini version (Commercial + Azure Government).')
param miniModelVersion string = '2025-04-14'

@description('Mini deployment SKU (GlobalStandard in Commercial; admin-plane flips to Standard in Azure Government).')
param miniModelSkuName string = 'GlobalStandard'

@description('Mini deployment capacity (thousands of TPM). Default 50 — mini turns are cheap, so headroom is inexpensive. Tune per quota.')
@minValue(1)
param miniModelCapacity int = 50

// --- Strong / reasoning model deployment (the "strong" tier) ----------------
// The Loom-native model tier router routes reasoning task classes (design /
// debug / multi-step / long-context) to this slot.
@description('Strong/reasoning deployment name (LOOM_AOAI_STRONG_DEPLOYMENT). The model tier router\'s "strong" tier.')
param strongDeploymentName string = 'strong'

@description('Strong/reasoning model name. Default gpt-4.1 — a current GA model available in Commercial AND Azure Government Standard. Operators RAISE to a stronger reasoning model (gpt-5.x / o-series) where regionally available; the tier router falls back to the standard/chat deployment when strong is unset.')
param strongModelName string = 'gpt-4.1'

@description('Strong/reasoning model version. 2025-04-14 is the current GA gpt-4.1 version (Commercial + Azure Government).')
param strongModelVersion string = '2025-04-14'

@description('Strong/reasoning deployment SKU (GlobalStandard in Commercial; admin-plane flips to Standard in Azure Government).')
param strongModelSkuName string = 'GlobalStandard'

@description('Strong/reasoning deployment capacity (thousands of TPM). Default 50. Tune per quota.')
@minValue(1)
param strongModelCapacity int = 50

// --- Inline-completion model deployment (optional) -------------------------
// Ghost-text inline completion (POST /api/copilot/complete) can run on a
// dedicated low-latency / cheaper model so it does not consume the chat
// deployment's TPM quota. When completionDeploymentName is empty NO deployment
// is created and the Console route falls back to the chat deployment
// (LOOM_AOAI_DEPLOYMENT). Leave empty in boundaries where the model is not
// available (e.g. some Azure Government regions) — ghost text still works via
// the chat deployment fallback.
@description('Inline-completion deployment name (LOOM_AOAI_COMPLETION_DEPLOYMENT). Empty = ghost text uses the chat deployment. Set to a faster/cheaper model slot (e.g. gpt-4o-mini) to keep ghost-text latency low without consuming chat quota.')
param completionDeploymentName string = ''

@description('Completion model name (only used when completionDeploymentName is set).')
param completionModelName string = 'gpt-4o-mini'

@description('Completion model version.')
param completionModelVersion string = '2024-07-18'

@description('Completion deployment SKU.')
param completionModelSkuName string = 'GlobalStandard'

@description('Completion deployment capacity (thousands of TPM).')
@minValue(1)
param completionModelCapacity int = 10

// --- RBAC -------------------------------------------------------------------
@description('Console UAMI principal (object) id — granted Azure AI Developer + Cognitive Services User + Cognitive Services OpenAI User on this account. Empty skips the grants.')
param consolePrincipalId string = ''

@description('MAF orchestration-tier UAMI principal (object) id — granted Cognitive Services OpenAI User on this account so the MAF Container App can call Gov AOAI direct. Empty skips the grant (Gov-only tier).')
param mafPrincipalId string = ''

@description('''AI Search service system-assigned MI principal (object) id — granted
Cognitive Services OpenAI User on this account so the Search service can call this
account''s text-embedding deployment SERVER-SIDE for integrated vectorization (an
`azureOpenAI` vectorizer / `AzureOpenAIEmbeddingSkill` authenticating with the
Search service identity, not a key). AIF-2 — without this grant the vectorizer
returns 401 at index/query time. Empty skips the grant (BYO/keyed Search).''')
param searchPrincipalId string = ''

@description('principalType for the role assignments. ServicePrincipal for a UAMI.')
@allowed(['ServicePrincipal', 'User', 'Group'])
param principalType string = 'ServicePrincipal'

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Log Analytics workspace ID for diagnostic settings. Empty skips diagnostics.')
param workspaceId string = ''

@description('Compliance tags')
param complianceTags object = {}

// Built-in role definition GUIDs (stable across clouds).
var roleAzureAIDeveloper = '64702f94-c441-49e6-a78b-ef80e0188fee'
var roleCognitiveServicesUser = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var roleCognitiveServicesOpenAIUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

// =====================================================================
// AIServices (AI Foundry) account — kind=AIServices with project mgmt on.
// =====================================================================
resource account 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' = {
  name: accountName
  location: location
  tags: complianceTags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: customSubDomainName
    // Microsoft Foundry project management — required so accounts/projects
    // child resources and the Agent Service endpoint work.
    allowProjectManagement: true
    publicNetworkAccess: publicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: { defaultAction: publicNetworkAccess ? 'Allow' : 'Deny' }
    disableLocalAuth: disableLocalAuth
  }
}

// =====================================================================
// Foundry Agent Service project (child of the account).
// Endpoint shape: https://<subdomain>.services.ai.azure.com/api/projects/<project>
// =====================================================================
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  parent: account
  name: projectName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: projectDisplayName
    description: 'CSA Loom Agent Service project — agent runtime + grounding'
  }
}

// =====================================================================
// Model deployments. Embedding depends on chat so the two serialize
// (CognitiveServices rejects concurrent deployment writes on one account).
//
// The 'chat' deployment backs ALL Loom Copilot surfaces from one model:
//   - the cross-item Copilot orchestrator (/api/copilot/orchestrate)
//   - the Notebook chat drawer (/api/copilot/notebook-assist)
//   - the per-cell in-cell Copilot (/api/notebook/[id]/assist) — /explain,
//     /fix, /comments, /optimize, and free-form refactor. No extra deployment,
//     env var, or RBAC is required for the in-cell surface beyond what this
//     module already wires into admin-plane/main.bicep (LOOM_AOAI_ENDPOINT +
//     LOOM_AOAI_DEPLOYMENT) and the role assignments granted below.
// =====================================================================
resource chatDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = {
  parent: account
  name: chatDeploymentName
  sku: {
    name: chatModelSkuName
    capacity: chatModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: chatModelName
      version: chatModelVersion
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

resource embedDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = {
  parent: account
  name: embedDeploymentName
  dependsOn: [ chatDeployment ]
  sku: {
    name: embedModelSkuName
    capacity: embedModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: embedModelName
      version: embedModelVersion
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

// Model-strategy "mini" tier — cheap/fast slot the tier router sends lightweight
// task classes to. Serializes after embed (CognitiveServices rejects concurrent
// deployment writes on one account).
resource miniDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = {
  parent: account
  name: miniDeploymentName
  dependsOn: [ embedDeployment ]
  sku: {
    name: miniModelSkuName
    capacity: miniModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: miniModelName
      version: miniModelVersion
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

// Model-strategy "strong" tier — reasoning slot the tier router sends reasoning
// task classes to. Serializes after mini.
resource strongDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = {
  parent: account
  name: strongDeploymentName
  dependsOn: [ miniDeployment ]
  sku: {
    name: strongModelSkuName
    capacity: strongModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: strongModelName
      version: strongModelVersion
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

// Optional dedicated inline-completion (ghost text) deployment. Serializes
// after strong so the deployments do not write the account concurrently
// (CognitiveServices rejects concurrent deployment writes on one account).
resource completionDeployment 'Microsoft.CognitiveServices/accounts/deployments@2025-04-01-preview' = if (!empty(completionDeploymentName)) {
  parent: account
  name: !empty(completionDeploymentName) ? completionDeploymentName : 'placeholder-unused'
  dependsOn: [ strongDeployment ]
  sku: {
    name: completionModelSkuName
    capacity: completionModelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: completionModelName
      version: completionModelVersion
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

// =====================================================================
// RBAC — Console UAMI on the account.
// =====================================================================
resource raAzureAIDeveloper 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, roleAzureAIDeveloper)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAzureAIDeveloper)
    principalId: consolePrincipalId
    principalType: principalType
  }
}

resource raCognitiveServicesUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, roleCognitiveServicesUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleCognitiveServicesUser)
    principalId: consolePrincipalId
    principalType: principalType
  }
}

resource raCognitiveServicesOpenAIUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, roleCognitiveServicesOpenAIUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleCognitiveServicesOpenAIUser)
    principalId: consolePrincipalId
    principalType: principalType
  }
}

// MAF orchestration tier — same Cognitive Services OpenAI User grant so the
// loom-copilot-maf Container App can call this account's AOAI deployments
// directly (Gov AOAI, *.openai.azure.us). Account-scope, in-module, so the
// principalId is start-time-known (no BCP177 across modules).
resource raMafOpenAIUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(mafPrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, mafPrincipalId, roleCognitiveServicesOpenAIUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleCognitiveServicesOpenAIUser)
    principalId: mafPrincipalId
    principalType: principalType
  }
}

// AI Search integrated vectorization (AIF-2) — grant the AI Search service's
// system-assigned MI Cognitive Services OpenAI User on this AOAI account so the
// server-side `azureOpenAI` vectorizer / AzureOpenAIEmbeddingSkill can embed
// text with THIS account's text-embedding deployment using its own identity
// (keyless, disableLocalAuth-compatible). Account-scope, in-module — the
// principalId is passed in as a param (start-time-known here), so no BCP177.
// Without this grant the integrated vectorizer returns 401 at index/query time.
resource raSearchOpenAIUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(searchPrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, searchPrincipalId, roleCognitiveServicesOpenAIUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleCognitiveServicesOpenAIUser)
    principalId: searchPrincipalId
    principalType: principalType
  }
}

// =====================================================================
// Diagnostics
// =====================================================================
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: account
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// =====================================================================
// Private endpoint (Gap C) — only when a PE subnet is supplied (sovereign /
// private-only boundaries). groupId 'account' is the cross-service AIServices
// group; the zone group binds BOTH privatelink.openai (AOAI inference) and
// privatelink.cognitiveservices (token/keys) so AAD + key auth both resolve
// privately. Commercial keeps publicNetworkAccess=true and passes no subnet,
// so this resource is skipped and day-one works without VNet plumbing.
// =====================================================================
resource accountPe 'Microsoft.Network/privateEndpoints@2023-11-01' = if (!empty(privateEndpointSubnetId)) {
  name: 'pe-${accountName}'
  location: location
  tags: complianceTags
  // A CognitiveServices account can report back to ARM while still in provisioning
  // state 'Accepted', which makes a private endpoint PUT race ahead and fail
  // ("Call to Microsoft.CognitiveServices/accounts failed ... Account ... in state
  // Accepted" — seen live in usgovvirginia). The model deployments below only
  // succeed once the account has fully reached 'Succeeded', so depending on them
  // (embedDeployment transitively depends on chatDeployment -> account)
  // deterministically holds the PE until the account is ready.
  dependsOn: [
    account
    chatDeployment
    embedDeployment
  ]
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'plsc-${accountName}'
        properties: {
          privateLinkServiceId: account.id
          groupIds: [ 'account' ]
        }
      }
    ]
  }
}

resource accountPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (!empty(privateEndpointSubnetId) && (!empty(privateDnsZoneOpenAiId) || !empty(privateDnsZoneCognitiveServicesId))) {
  parent: accountPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: concat(
      empty(privateDnsZoneOpenAiId) ? [] : [
        { name: 'openai', properties: { privateDnsZoneId: privateDnsZoneOpenAiId } }
      ],
      empty(privateDnsZoneCognitiveServicesId) ? [] : [
        { name: 'cognitiveservices', properties: { privateDnsZoneId: privateDnsZoneCognitiveServicesId } }
      ]
    )
  }
}

// =====================================================================
// Outputs — consumed by admin-plane/main.bicep to wire the Console env.
// =====================================================================
output accountId string = account.id
output accountNameOut string = account.name
@description('LOOM_AOAI_ENDPOINT — the account OpenAI inference endpoint. Suffix is sovereign-correct: openai.azure.us in Gov (GCC-High/IL5), openai.azure.com elsewhere — so LOOM_AOAI_ENDPOINT / LOOM_AZURE_OPENAI_ENDPOINT do not 401 on the cognitiveservices.azure.us token audience in Gov.')
output aoaiEndpoint string = 'https://${account.properties.customSubDomainName}.${environment().suffixes.storage != 'core.windows.net' ? 'openai.azure.us' : 'openai.azure.com'}/'
@description('LOOM_FOUNDRY_PROJECT_ENDPOINT — Agent Service project endpoint. Sovereign-correct: services.ai.azure.us in Gov (GCC-High/IL5), services.ai.azure.com elsewhere — https://learn.microsoft.com/azure/foundry/concepts/foundry-azure-government#endpoints')
output projectEndpoint string = 'https://${account.properties.customSubDomainName}.${environment().suffixes.storage != 'core.windows.net' ? 'services.ai.azure.us' : 'services.ai.azure.com'}/api/projects/${project.name}'
@description('LOOM_FOUNDRY_PROJECT_ID — stable ARM resource id of the project.')
output projectId string = project.id
@description('LOOM_FOUNDRY_PROJECT_NAME')
output projectNameOut string = project.name
@description('LOOM_AOAI_CHAT_DEPLOYMENT')
output chatDeployment string = chatDeployment.name
@description('LOOM_AOAI_EMBED_DEPLOYMENT')
output embedDeployment string = embedDeployment.name
@description('LOOM_AOAI_MINI_DEPLOYMENT — the model tier router\'s "mini" (cheap/lightweight) tier deployment.')
output miniDeployment string = miniDeployment.name
@description('LOOM_AOAI_STRONG_DEPLOYMENT — the model tier router\'s "strong" (reasoning) tier deployment.')
output strongDeployment string = strongDeployment.name
@description('LOOM_AOAI_COMPLETION_DEPLOYMENT — empty when no dedicated inline-completion slot is deployed; the Console route then falls back to the chat deployment for ghost text.')
output completionDeployment string = !empty(completionDeploymentName) ? completionDeploymentName : ''
output accountPrincipalId string = account.identity.principalId
@description('LOOM_<SVC>_ENDPOINT for the AI-enrichment pipeline activities — the multi-service Azure AI Services custom-domain endpoint (https://<subdomain>.cognitiveservices.azure.com/). This kind=AIServices account serves the Document Intelligence / Vision / Language / Translator / Content Safety data planes (/documentintelligence, /computervision, /language, /translator, /contentsafety) under one endpoint, and the Console UAMI is granted "Cognitive Services User" above — so those activities run day-one with no dedicated single-kind accounts (no-vaporware / default-on).')
output aiServicesEndpoint string = account.properties.endpoint
