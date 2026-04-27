// Azure AI Foundry — shared module
//
// Provisions the minimum production-shaped Azure AI Foundry footprint:
//   - AI Foundry Hub (workspace kind=Hub)
//   - At least one Project (workspace kind=Project) attached to the Hub
//   - Connections to AOAI, AI Search, ACR, Application Insights, Key Vault,
//     and Storage (the dependencies Foundry expects)
//   - Capability Host on the Hub for Agent Service workloads
//   - System-assigned identity + role grants on dependent resources
//
// Use as a module:
//   module foundry 'shared/modules/aifoundry.bicep' = {
//     name: 'foundry-${env}'
//     params: {
//       env: env
//       location: location
//       aoaiResourceId: aoai.outputs.resourceId
//       aiSearchResourceId: search.outputs.resourceId
//       storageAccountResourceId: storage.outputs.resourceId
//       keyVaultResourceId: kv.outputs.resourceId
//       containerRegistryResourceId: acr.outputs.resourceId
//       applicationInsightsResourceId: ai.outputs.resourceId
//     }
//   }
//
// References:
//   https://learn.microsoft.com/azure/ai-studio/concepts/architecture
//   https://learn.microsoft.com/azure/ai-studio/how-to/manage-resources

@description('Environment short name — feeds resource naming + sizing decisions.')
@allowed(['dev', 'test', 'prod'])
param env string = 'dev'

@description('Location for all Foundry resources.')
param location string = resourceGroup().location

@description('Display name for the Hub. Defaults to "csa-foundry-<env>".')
param hubName string = 'csa-foundry-${env}'

@description('Friendly display name shown in the AI Studio portal.')
param hubFriendlyName string = 'CSA-in-a-Box AI Foundry Hub (${env})'

@description('Workspace SKU. Use Basic for dev/test, Standard for prod.')
@allowed(['Basic', 'Standard'])
param hubSku string = env == 'prod' ? 'Standard' : 'Basic'

@description('Public network access on the Hub. Disable in prod and use private endpoints.')
@allowed(['Enabled', 'Disabled'])
param hubPublicNetworkAccess string = env == 'prod' ? 'Disabled' : 'Enabled'

@description('Name of the default Project under the Hub.')
param projectName string = 'csa-foundry-${env}-default'

@description('Resource ID of the Storage account Foundry will use.')
param storageAccountResourceId string

@description('Resource ID of the Key Vault Foundry will use.')
param keyVaultResourceId string

@description('Resource ID of the Application Insights Foundry will use.')
param applicationInsightsResourceId string

@description('Resource ID of the Container Registry Foundry will use (for hosted agents + custom envs).')
param containerRegistryResourceId string

@description('Resource ID of the Azure OpenAI account to wire as a connection.')
param aoaiResourceId string

@description('AOAI account name (for endpoint URL construction in connection target).')
param aoaiName string

@description('Resource ID of the Azure AI Search service to wire as a connection. Empty to skip.')
param aiSearchResourceId string = ''

@description('AI Search service name. Required if aiSearchResourceId is set.')
param aiSearchName string = ''

@description('Provision a Capability Host on the Hub (required for Agent Service workloads).')
param enableCapabilityHost bool = true

@description('Tags applied to every resource in this module.')
param tags object = {
  workload: 'csa-ai-foundry'
  environment: env
  managed_by: 'bicep'
}

// ============================================================================
// Hub workspace (kind = Hub)
// ============================================================================

resource hub 'Microsoft.MachineLearningServices/workspaces@2025-09-01' = {
  name: hubName
  location: location
  tags: tags
  kind: 'Hub'
  identity: { type: 'SystemAssigned' }
  sku: { name: hubSku, tier: hubSku }
  properties: {
    friendlyName: hubFriendlyName
    description: 'Centralized AI Foundry Hub provisioned by csa-inabox shared module.'
    storageAccount: storageAccountResourceId
    keyVault: keyVaultResourceId
    applicationInsights: applicationInsightsResourceId
    containerRegistry: containerRegistryResourceId
    publicNetworkAccess: hubPublicNetworkAccess
    hbiWorkspace: false
    v1LegacyMode: false
    managedNetwork: {
      isolationMode: env == 'prod' ? 'AllowOnlyApprovedOutbound' : 'AllowInternetOutbound'
    }
    enableDataIsolation: true
  }
}

// ============================================================================
// Connections (Hub level — inherited by all Projects)
// ============================================================================

resource aoaiConnection 'Microsoft.MachineLearningServices/workspaces/connections@2025-09-01' = {
  parent: hub
  name: 'aoai'
  properties: {
    category: 'AzureOpenAI'
    target: 'https://${aoaiName}.openai.azure.com/'
    authType: 'AAD'
    isSharedToAll: true
    metadata: {
      ApiType: 'Azure'
      ResourceId: aoaiResourceId
    }
  }
}

resource searchConnection 'Microsoft.MachineLearningServices/workspaces/connections@2025-09-01' = if (!empty(aiSearchResourceId)) {
  parent: hub
  name: 'aisearch'
  properties: {
    category: 'CognitiveSearch'
    target: 'https://${aiSearchName}.search.windows.net'
    authType: 'AAD'
    isSharedToAll: true
    metadata: {
      ResourceId: aiSearchResourceId
    }
  }
}

// ============================================================================
// Capability Host (Agent Service support)
// ============================================================================

resource capabilityHost 'Microsoft.MachineLearningServices/workspaces/capabilityHosts@2025-09-01' = if (enableCapabilityHost) {
  parent: hub
  name: 'agents-host'
  properties: {
    capabilityHostKind: 'Agents'
    aiServicesConnections: [
      aoaiConnection.name
    ]
    vectorStoreConnections: empty(aiSearchResourceId) ? [] : [
      searchConnection.name
    ]
    storageConnections: []  // uses Hub default storage
  }
}

// ============================================================================
// Project (a workspace of kind=Project under the Hub)
// ============================================================================

resource project 'Microsoft.MachineLearningServices/workspaces@2025-09-01' = {
  name: projectName
  location: location
  tags: tags
  kind: 'Project'
  identity: { type: 'SystemAssigned' }
  sku: { name: hubSku, tier: hubSku }
  properties: {
    friendlyName: 'CSA Default Project (${env})'
    description: 'Default Foundry project for csa-inabox. Add more projects per LOB / team.'
    hubResourceId: hub.id
    hbiWorkspace: false
    v1LegacyMode: false
    publicNetworkAccess: hubPublicNetworkAccess
  }
}

// ============================================================================
// Role assignments — grant Hub identity access to dependent resources
// ============================================================================

// Storage Blob Data Contributor on the Storage account
var roleStorageBlobContrib = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource hubStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(storageAccountResourceId, hub.id, roleStorageBlobContrib)
  properties: {
    principalId: hub.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleStorageBlobContrib)
  }
}

// Key Vault Secrets Officer on the Key Vault
var roleKvSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
resource hubKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(keyVaultResourceId, hub.id, roleKvSecretsOfficer)
  properties: {
    principalId: hub.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsOfficer)
  }
}

// AcrPull on the Container Registry (so Foundry can pull custom env images)
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource hubAcrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(containerRegistryResourceId, hub.id, roleAcrPull)
  properties: {
    principalId: hub.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
  }
}

// Cognitive Services OpenAI User on the AOAI account
var roleAoaiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
resource hubAoaiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(aoaiResourceId, hub.id, roleAoaiUser)
  properties: {
    principalId: hub.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAoaiUser)
  }
}

// ============================================================================
// Outputs
// ============================================================================

@description('Resource ID of the Foundry Hub workspace.')
output hubResourceId string = hub.id

@description('Name of the Foundry Hub workspace.')
output hubName string = hub.name

@description('System-assigned principal ID of the Hub.')
output hubPrincipalId string = hub.identity.principalId

@description('Resource ID of the default Project workspace.')
output projectResourceId string = project.id

@description('Name of the default Project.')
output projectName string = project.name

@description('Discovery URL for the Foundry portal (used by client SDKs).')
output projectDiscoveryUrl string = 'https://${location}.api.azureml.ms/discovery'
