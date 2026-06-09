// CSA Loom — AI Foundry (AIServices) account + Agent Service project + models
// =============================================================================
// Encodes the LIVE Commercial deployment one-for-one so a fresh `az deployment`
// reproduces it (no-vaporware bicep-sync requirement). This is the DEDICATED
// Foundry Agent Service account the Console BFF targets via
// LOOM_FOUNDRY_PROJECT_ENDPOINT — distinct from the shared AzureML Foundry Hub
// in ../admin-plane/ai-foundry.bicep.
//
// Live mapping (sub 363ef5d1-0e77-4594-a530-f51af23dbf8c, rg-csa-loom-admin-eastus2):
//   account  : aifndry-loom-eastus2  (Microsoft.CognitiveServices/accounts kind=AIServices, S0, custom domain)
//   project  : loom-agents           (accounts/projects, 2025-04-01-preview, SystemAssigned)
//   model #1 : chat                  = gpt-4.1-mini  v2025-04-14  (GlobalStandard, cap 10)
//   model #2 : text-embedding-ada-002= text-embedding-ada-002 v2 (Standard,       cap 10)
//   grants   : Console UAMI -> Azure AI Developer
//                              Cognitive Services User
//                              Cognitive Services OpenAI User   (account scope)
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

// --- Chat model deployment -------------------------------------------------
@description('Chat deployment name (LOOM_AOAI_CHAT_DEPLOYMENT).')
param chatDeploymentName string = 'chat'

@description('Chat model name.')
param chatModelName string = 'gpt-4.1-mini'

@description('Chat model version.')
param chatModelVersion string = '2025-04-14'

@description('Chat deployment SKU (GlobalStandard for gpt-4.1-mini).')
param chatModelSkuName string = 'GlobalStandard'

@description('Chat deployment capacity (thousands of TPM).')
@minValue(1)
param chatModelCapacity int = 10

// --- Embedding model deployment --------------------------------------------
@description('Embedding deployment name (LOOM_AOAI_EMBED_DEPLOYMENT).')
param embedDeploymentName string = 'text-embedding-ada-002'

@description('Embedding model name.')
param embedModelName string = 'text-embedding-ada-002'

@description('Embedding model version.')
param embedModelVersion string = '2'

@description('Embedding deployment SKU.')
param embedModelSkuName string = 'Standard'

@description('Embedding deployment capacity (thousands of TPM).')
@minValue(1)
param embedModelCapacity int = 10

// --- RBAC -------------------------------------------------------------------
@description('Console UAMI principal (object) id — granted Azure AI Developer + Cognitive Services User + Cognitive Services OpenAI User on this account. Empty skips the grants.')
param consolePrincipalId string = ''

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
// Outputs — consumed by admin-plane/main.bicep to wire the Console env.
// =====================================================================
output accountId string = account.id
output accountNameOut string = account.name
@description('LOOM_AOAI_ENDPOINT — the account OpenAI inference endpoint. Suffix is sovereign-correct: openai.azure.us in Gov (GCC-High/IL5), openai.azure.com elsewhere — so LOOM_AOAI_ENDPOINT / LOOM_AZURE_OPENAI_ENDPOINT do not 401 on the cognitiveservices.azure.us token audience in Gov.')
output aoaiEndpoint string = 'https://${account.properties.customSubDomainName}.${environment().suffixes.storage != 'core.windows.net' ? 'openai.azure.us' : 'openai.azure.com'}/'
@description('LOOM_FOUNDRY_PROJECT_ENDPOINT — Agent Service project endpoint.')
output projectEndpoint string = 'https://${account.properties.customSubDomainName}.services.ai.azure.com/api/projects/${project.name}'
@description('LOOM_FOUNDRY_PROJECT_ID — stable ARM resource id of the project.')
output projectId string = project.id
@description('LOOM_FOUNDRY_PROJECT_NAME')
output projectNameOut string = project.name
@description('LOOM_AOAI_CHAT_DEPLOYMENT')
output chatDeployment string = chatDeployment.name
@description('LOOM_AOAI_EMBED_DEPLOYMENT')
output embedDeployment string = embedDeployment.name
output accountPrincipalId string = account.identity.principalId
