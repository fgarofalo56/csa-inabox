// Azure Machine Learning workspace — shared module
//
// Provisions a production-shaped Azure ML workspace for classical ML / MLOps
// workloads (model training, batch inference, online endpoints). Distinct
// from `aifoundry.bicep` which provisions the GenAI-focused Foundry surface.
//
// When to use which:
//   - Classical ML, Auto-ML, designer pipelines, MLflow tracking → use this
//   - GenAI agents, prompt flow, foundation-model fine-tuning, Agent Service
//     → use `aifoundry.bicep`
//   - Both are valid and can coexist in the same RG.
//
// Usage:
//   module aml 'shared/modules/azureml.bicep' = {
//     name: 'aml-${env}'
//     params: {
//       env: env
//       location: location
//       storageAccountResourceId: storage.outputs.resourceId
//       keyVaultResourceId: kv.outputs.resourceId
//       applicationInsightsResourceId: ai.outputs.resourceId
//       containerRegistryResourceId: acr.outputs.resourceId
//     }
//   }

@description('Environment short name.')
@allowed(['dev', 'test', 'prod'])
param env string = 'dev'

@description('Location for the AML workspace.')
param location string = resourceGroup().location

@description('Workspace name. Defaults to "csa-aml-<env>".')
param workspaceName string = 'csa-aml-${env}'

@description('Friendly display name in the AML Studio portal.')
param friendlyName string = 'CSA-in-a-Box ML Workspace (${env})'

@description('Workspace SKU.')
@allowed(['Basic', 'Standard'])
param sku string = env == 'prod' ? 'Standard' : 'Basic'

@description('Public network access. Disabled in prod with private endpoints.')
@allowed(['Enabled', 'Disabled'])
param publicNetworkAccess string = env == 'prod' ? 'Disabled' : 'Enabled'

@description('Managed network isolation mode.')
@allowed(['Disabled', 'AllowInternetOutbound', 'AllowOnlyApprovedOutbound'])
param managedNetworkIsolation string = env == 'prod' ? 'AllowOnlyApprovedOutbound' : 'AllowInternetOutbound'

@description('Mark workspace as High Business Impact (HBI). Affects diagnostic logging.')
param hbiWorkspace bool = env == 'prod'

@description('Resource ID of the Storage account.')
param storageAccountResourceId string

@description('Resource ID of the Key Vault.')
param keyVaultResourceId string

@description('Resource ID of the Application Insights component.')
param applicationInsightsResourceId string

@description('Resource ID of the Container Registry.')
param containerRegistryResourceId string

@description('Provision a default user-assigned identity for compute clusters.')
param createComputeIdentity bool = true

@description('Provision an example serverless compute pool. Set false to skip.')
param createServerlessCompute bool = true

@description('Tags applied to every resource.')
param tags object = {
  workload: 'csa-azureml'
  environment: env
  managed_by: 'bicep'
}

// ============================================================================
// User-assigned managed identity (for compute clusters / online endpoints)
// ============================================================================

resource computeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (createComputeIdentity) {
  name: 'id-csa-aml-compute-${env}'
  location: location
  tags: tags
}

// ============================================================================
// Workspace
// ============================================================================

resource workspace 'Microsoft.MachineLearningServices/workspaces@2025-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  kind: 'Default'
  identity: { type: 'SystemAssigned' }
  sku: { name: sku, tier: sku }
  properties: {
    friendlyName: friendlyName
    description: 'CSA-in-a-Box Azure ML workspace provisioned by shared module.'
    storageAccount: storageAccountResourceId
    keyVault: keyVaultResourceId
    applicationInsights: applicationInsightsResourceId
    containerRegistry: containerRegistryResourceId
    publicNetworkAccess: publicNetworkAccess
    hbiWorkspace: hbiWorkspace
    v1LegacyMode: false
    allowPublicAccessWhenBehindVnet: false
    managedNetwork: {
      isolationMode: managedNetworkIsolation
    }
    enableDataIsolation: true
    primaryUserAssignedIdentity: createComputeIdentity ? computeIdentity.id : null
  }
}

// ============================================================================
// Default serverless compute pool (CPU; add GPU separately when needed)
// ============================================================================

resource serverlessCompute 'Microsoft.MachineLearningServices/workspaces/computes@2025-09-01' = if (createServerlessCompute) {
  parent: workspace
  name: 'cpu-cluster'
  location: location
  identity: createComputeIdentity ? {
    type: 'UserAssigned'
    userAssignedIdentities: { '${computeIdentity.id}': {} }
  } : null
  properties: {
    computeType: 'AmlCompute'
    properties: {
      vmSize: 'Standard_DS3_v2'
      vmPriority: env == 'prod' ? 'Dedicated' : 'LowPriority'
      scaleSettings: {
        minNodeCount: 0
        maxNodeCount: env == 'prod' ? 8 : 2
        nodeIdleTimeBeforeScaleDown: 'PT300S'
      }
      enableNodePublicIp: false
      remoteLoginPortPublicAccess: 'Disabled'
      osType: 'Linux'
    }
    disableLocalAuth: true
  }
}

// ============================================================================
// Role assignments (workspace identity → dependent resources)
// ============================================================================

var roleStorageBlobContrib = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource workspaceStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(storageAccountResourceId, workspace.id, roleStorageBlobContrib)
  properties: {
    principalId: workspace.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleStorageBlobContrib)
  }
}

var roleKvSecretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
resource workspaceKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(keyVaultResourceId, workspace.id, roleKvSecretsOfficer)
  properties: {
    principalId: workspace.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKvSecretsOfficer)
  }
}

var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource workspaceAcrRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: resourceGroup()
  name: guid(containerRegistryResourceId, workspace.id, roleAcrPull)
  properties: {
    principalId: workspace.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
  }
}

// Compute identity also needs to read training data
resource computeStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createComputeIdentity) {
  scope: resourceGroup()
  name: guid(storageAccountResourceId, computeIdentity.id, roleStorageBlobContrib)
  properties: {
    principalId: computeIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleStorageBlobContrib)
  }
}

// ============================================================================
// Outputs
// ============================================================================

@description('Resource ID of the AML workspace.')
output workspaceId string = workspace.id

@description('Name of the AML workspace.')
output workspaceName string = workspace.name

@description('System-assigned principal ID of the workspace.')
output workspacePrincipalId string = workspace.identity.principalId

@description('Resource ID of the user-assigned compute identity (if created).')
output computeIdentityId string = createComputeIdentity ? computeIdentity.id : ''

@description('Discovery URL for SDK clients.')
output discoveryUrl string = 'https://${location}.api.azureml.ms/discovery'

@description('MLflow tracking URI for use in training scripts.')
output mlflowTrackingUri string = 'azureml://${location}.api.azureml.ms/mlflow/v1.0/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.MachineLearningServices/workspaces/${workspaceName}'
