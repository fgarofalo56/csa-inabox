// CSA Loom — Azure AI Foundry Hub + Project
// Hub is shared (one per Admin Plane); Projects scope per workspace.
// AOAI + AI Services connections registered as Hub connections.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Boundary — controls Foundry vs Azure ML classic dispatch')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Whether Foundry Portal is available in this boundary (false uses Azure ML classic)')
param foundryPortalEnabled bool

@description('Storage account name for Hub (workspace-specific datastore)')
param hubStorageAccountId string

@description('Key Vault ID for Hub secret store')
param hubKeyVaultId string

@description('Container Registry ID')
param hubContainerRegistryId string

@description('Application Insights ID for Hub telemetry')
param hubAppInsightsId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Private endpoint subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for AML')
param privateDnsZoneAmlId string

@description('Private DNS zone ID for AML API')
param privateDnsZoneAmlApiId string

@description('Private DNS zone ID for notebooks')
param privateDnsZoneNotebooksId string

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Console UAMI principal ID — granted Cognitive Services Contributor on the model-hosting account so the BFF can deploy models / read quota / read keys. Empty skips the role assignment.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

// =====================================================================
// Foundry Hub (Azure ML Workspace kind=Hub for Foundry; kind=Default
// for classic in boundaries without Foundry support)
// =====================================================================

var workspaceKind = foundryPortalEnabled ? 'Hub' : 'Default'

resource foundryHub 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: 'aifoundry-csa-loom-${location}'
  location: location
  tags: complianceTags
  kind: workspaceKind
  sku: { name: 'Basic', tier: 'Basic' }
  identity: { type: 'SystemAssigned' }
  properties: {
    friendlyName: 'CSA Loom AI Foundry Hub'
    description: 'Shared AI Foundry Hub for Loom Console agent runtime + Data Agents grounding'
    storageAccount: hubStorageAccountId
    keyVault: hubKeyVaultId
    containerRegistry: hubContainerRegistryId
    applicationInsights: hubAppInsightsId
    publicNetworkAccess: 'Disabled'
    managedNetwork: {
      isolationMode: 'AllowOnlyApprovedOutbound'
      outboundRules: {}
    }
    hbiWorkspace: boundary == 'IL5' || boundary == 'GCC-High'
    v1LegacyMode: false
  }
}

// Azure ML Owner role to admin group
resource hubOwnerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: foundryHub
  name: guid(foundryHub.id, adminEntraGroupId, 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
  properties: {
    // AzureML Data Scientist
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'f6c7c914-8db3-469d-8ca1-694a8f32e121')
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

// Console UAMI → AzureML Data Scientist on the Foundry Hub workspace. This one
// data-plane grant serves several BFF surfaces:
//   - ml-model + ml-experiment editors → foundry-client.ts (listMlWorkspaces /
//     listModels / listModelVersions / getModel / registerModelVersion /
//     createOnlineEndpoint) AND mlflow-client.ts experiment tracking
//     (searchRuns / getMetricHistory). Without this grant they 403 on a clean deploy.
//   - notebook Library & Environment management → aml-environments-client.ts
//     (list + register AML Environment versions; read + environment-version PUT)
//   - ml-model editor stage-transition + register-from-run → MLflow registry
//     data plane (model-versions/transition-stage, model-versions/create).
//     Stages are an MLflow-layer concept (Learn "how-to-manage-models-mlflow");
//     no new Azure resource is required, only this role grant — without it the
//     MLflow REST calls 403.
// Role f6c7c914-8db3-469d-8ca1-694a8f32e121 = AzureML Data Scientist.
resource hubConsoleDataScientist 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: foundryHub
  name: guid(foundryHub.id, consolePrincipalId, 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
  properties: {
    // AzureML Data Scientist
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'f6c7c914-8db3-469d-8ca1-694a8f32e121')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// AzureML Compute Operator — lets the Console UAMI list / start / stop /
// restart Compute Instances on the Foundry hub workspace. Required by the CI
// lifecycle BFF routes:
//   GET  /api/foundry/computes
//   POST /api/foundry/computes/{id}/start
//   GET  /api/foundry/computes/{id}/status
// `AzureML Data Scientist` (granted to the admin group above) does NOT include
// Microsoft.MachineLearningServices/workspaces/computes/* — so without this
// grant the routes return 403 with an honest-gate MessageBar naming this role.
// Role: e503ece1-11d0-4e8e-8e2c-7a6c3bf38815
resource amlComputeOperatorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: foundryHub
  name: guid(foundryHub.id, consolePrincipalId, 'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815')
  properties: {
    // AzureML Compute Operator
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Private endpoint to the Hub
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${foundryHub.name}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'aml-link'
        properties: {
          privateLinkServiceId: foundryHub.id
          groupIds: ['amlworkspace']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'aml', properties: { privateDnsZoneId: privateDnsZoneAmlId } }
      { name: 'amlapi', properties: { privateDnsZoneId: privateDnsZoneAmlApiId } }
      { name: 'notebooks', properties: { privateDnsZoneId: privateDnsZoneNotebooksId } }
    ]
  }
}

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: foundryHub
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
// Model-hosting account (Cognitive Services kind=AIServices).
// This is what hosts AOAI model deployments, regional quota, keys and the
// inference endpoint. The Foundry hub above does NOT host deployments —
// the Loom hub editor's Models / Quota / Keys / Networking / RBAC tabs all
// target THIS account (foundry-cs-client.ts resolves it by name).
// =====================================================================

resource aiServices 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'aoai-csa-loom-${location}'
  location: location
  tags: complianceTags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'aoai-csa-loom-${location}'
    // Enable Microsoft Foundry project management on this AIServices account so
    // the Foundry Agent Service (data-agent Publish + Foundry agent editor) has a
    // real project endpoint to target (foundry-agent-client.ts). The property is
    // valid on the runtime API; the bundled bicep type lib is behind, hence the
    // suppression below.
    #disable-next-line BCP037
    allowProjectManagement: true
    publicNetworkAccess: boundary == 'Commercial' ? 'Enabled' : 'Disabled'
    networkAcls: { defaultAction: boundary == 'Commercial' ? 'Allow' : 'Deny' }
    disableLocalAuth: false
  }
}

// Microsoft Foundry project (child of the AIServices account). Backs the
// Foundry Agent Service endpoint shaped
//   https://<account-subdomain>.services.ai.azure.com/api/projects/<project>
// which foundry-agent-client.ts targets. The project's internalId is the
// workspace GUID downstream Foundry / Copilot Studio connections paste in.
resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  parent: aiServices
  name: 'loom'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'CSA Loom'
    description: 'CSA Loom default Foundry project — Data Agents runtime + agent grounding'
  }
}

// Grant the Console UAMI Cognitive Services Contributor so the BFF can
// deploy models, read quota, read keys, and toggle public access.
resource aiServicesUamiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: aiServices
  name: guid(aiServices.id, consolePrincipalId, '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68')
  properties: {
    // Cognitive Services Contributor
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Grant the Console UAMI Cognitive Services OpenAI User so the BFF can run
// inference (chat/completions) against AOAI deployments — this is the role the
// AI Functions surface (sentiment/classify/translate/summarize/extract) needs
// to call the gpt-4o deployment. Granted explicitly (least-privilege) alongside
// Contributor, which the model-deploy/quota flows use.
// Also enables: Copilot chat, help-agent, the data-agent test chat, and the
// data-agent Config Copilot persona (agent-config-copilot — example-query +
// field-description generation grounded on a source's real schema). No new role
// or resource is required for the Config Copilot; it reuses this AOAI grant.
resource aiServicesOpenAIUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: aiServices
  name: guid(aiServices.id, consolePrincipalId, '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  properties: {
    // Cognitive Services OpenAI User — inference-only
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output hubId string = foundryHub.id
output hubName string = foundryHub.name
output hubKind string = workspaceKind
output hubManagedIdentityPrincipalId string = foundryHub.identity.principalId
output aiServicesAccountName string = aiServices.name
output aiServicesEndpoint string = aiServices.properties.endpoint
// AOAI inference endpoint (the .openai.azure.* host the AI Functions / Copilot
// clients call — distinct from the generic Cognitive Services endpoint above).
// Sovereign-aware: GCC-High / IL5 / IL6 use .openai.azure.us. Wired into
// LOOM_AOAI_ENDPOINT when only the shared Foundry hub is deployed.
output aoaiInferenceEndpoint string = environment().suffixes.storage != 'core.windows.net'
  ? 'https://${aiServices.properties.customSubDomainName}.openai.azure.us/'
  : 'https://${aiServices.properties.customSubDomainName}.openai.azure.com/'

// Foundry Agent Service project wiring (LOOM_FOUNDRY_PROJECT_ENDPOINT / _ID).
output projectName string = foundryProject.name
output projectEndpoint string = 'https://${aiServices.properties.customSubDomainName}.services.ai.azure.com/api/projects/${foundryProject.name}'
// The CognitiveServices project type doesn't surface a bare workspace GUID in
// bicep; the ARM resource id is the real, stable identifier the Foundry agent
// editor surfaces for downstream connection wiring.
output projectId string = foundryProject.id
