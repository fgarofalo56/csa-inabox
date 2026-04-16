// Azure Government - Platform Deployment Orchestrator
// Deploys CSA-in-a-Box platform to Azure Government (MAG) regions
// All services validated for FedRAMP High / IL4 / IL5 compliance

targetScope = 'subscription'

metadata name = 'CSA-in-a-Box Government Deployment'
metadata description = 'Deploys the complete Fabric-in-a-Box platform to Azure Government'

// ─── Parameters ───────────────────────────────────────────────────────────────

@allowed([
  'usgovvirginia'
  'usgovarizona'
  'usgovtexas'
  'usgoviowa'
])
@description('Azure Government region for deployment.')
param location string

@allowed(['dev', 'tst', 'stg', 'prod'])
@description('Deployment environment.')
param environment string = 'dev'

@minLength(2)
@maxLength(10)
@description('Resource naming prefix.')
param prefix string = 'csa'

@description('Enable FedRAMP High compliance controls.')
param enableFedRAMPHigh bool = true

@allowed(['CUI', 'FOUO', 'PII', 'PHI', 'Public'])
@description('Default data classification level.')
param dataClassification string = 'CUI'

@allowed(['IL2', 'IL4', 'IL5'])
@description('Impact level for DoD workloads.')
param impactLevel string = 'IL4'

@description('Deploy DLZ (Data Landing Zone) resources.')
param deployDLZ bool = true

@description('Deploy DMLZ (Data Management Landing Zone) resources.')
param deployDMLZ bool = true

@description('Deploy open-source alternatives on AKS.')
param deployOSSAlternatives bool = false

@description('Deploy AI integration services (Azure OpenAI, AI Search).')
param deployAIServices bool = true

@description('Deploy streaming infrastructure (Event Hubs, ADX).')
param deployStreaming bool = true

@description('Enable Customer-Managed Key (CMK) encryption across all supported services. Defaults to true for FedRAMP compliance.')
param enableCmk bool = true

@description('Enable HIPAA compliance controls (for health workloads).')
param enableHIPAA bool = false

@description('Tags applied to all resources.')
param tags object = {}

// ─── Variables ────────────────────────────────────────────────────────────────

var baseName = toLower('${prefix}-${environment}')

var govEndpoints = {
  activeDirectory: 'https://login.microsoftonline.us'
  resourceManager: 'https://management.usgovcloudapi.net'
  storage: 'core.usgovcloudapi.net'
  sql: 'database.usgovcloudapi.net'
  databricks: 'databricks.azure.us'
  keyVault: 'vault.usgovcloudapi.net'
  monitor: 'monitor.azure.us'
  purview: 'purview.azure.us'
}

var complianceTags = union(tags, {
  FedRAMP_Level: enableFedRAMPHigh ? 'High' : 'Moderate'
  FISMA_Impact: 'High'
  Data_Classification: dataClassification
  Impact_Level: impactLevel
  Compliance_Framework: 'NIST-800-53-Rev5'
  Cloud_Environment: 'AzureUSGovernment'
  Deployed_By: 'CSA-in-a-Box'
  HIPAA_Compliant: enableHIPAA ? 'Yes' : 'No'
})

// ─── Resource Groups ──────────────────────────────────────────────────────────

resource rgPlatform 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${baseName}-platform-${location}'
  location: location
  tags: complianceTags
}

resource rgData 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployDLZ) {
  name: 'rg-${baseName}-dlz-${location}'
  location: location
  tags: complianceTags
}

resource rgManagement 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployDMLZ) {
  name: 'rg-${baseName}-dmlz-${location}'
  location: location
  tags: complianceTags
}

resource rgStreaming 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployStreaming) {
  name: 'rg-${baseName}-streaming-${location}'
  location: location
  tags: complianceTags
}

resource rgAI 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployAIServices) {
  name: 'rg-${baseName}-ai-${location}'
  location: location
  tags: complianceTags
}

resource rgOSS 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployOSSAlternatives) {
  name: 'rg-${baseName}-oss-${location}'
  location: location
  tags: complianceTags
}

// ─── Core Platform ───────────────────────────────────────────────────────────

module keyVault 'modules/keyVault.bicep' = {
  name: '${baseName}-keyvault'
  scope: rgPlatform
  params: {
    name: '${baseName}-kv'
    location: location
    tags: complianceTags
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enableRbacAuthorization: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

module logAnalytics 'modules/logAnalytics.bicep' = {
  name: '${baseName}-logs'
  scope: rgPlatform
  params: {
    name: '${baseName}-logs'
    location: location
    tags: complianceTags
    retentionInDays: enableFedRAMPHigh ? 365 : 90
    dailyQuotaGb: -1
  }
}

// ─── Data Landing Zone ───────────────────────────────────────────────────────

module storage 'modules/storage.bicep' = if (deployDLZ) {
  name: '${baseName}-storage'
  scope: rgData
  params: {
    name: replace('${baseName}stor', '-', '')
    location: location
    tags: complianceTags
    sku: environment == 'prod' ? 'Standard_GRS' : 'Standard_LRS'
    kind: 'StorageV2'
    isHnsEnabled: true  // Hierarchical namespace for ADLS Gen2
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    containers: [
      'bronze'
      'silver'
      'gold'
      'sandbox'
      'staging'
    ]
    enableCustomerManagedKey: enableCmk
    keyVaultId: keyVault.outputs.keyVaultId
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module databricks 'modules/databricks.bicep' = if (deployDLZ) {
  name: '${baseName}-dbx'
  scope: rgData
  params: {
    name: '${baseName}-dbx'
    location: location
    tags: complianceTags
    pricingTier: 'premium'  // Required for Unity Catalog
    enableNoPublicIp: true
    requireInfrastructureEncryption: enableCmk
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module synapse 'modules/synapse.bicep' = if (deployDLZ) {
  name: '${baseName}-syn'
  scope: rgData
  params: {
    name: '${baseName}-syn'
    location: location
    tags: complianceTags
    storageAccountId: (deployDLZ && storage != null) ? storage!.outputs.storageAccountId : ''
    managedVirtualNetwork: 'default'
    preventDataExfiltration: true
    publicNetworkAccess: 'Disabled'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module dataFactory 'modules/dataFactory.bicep' = if (deployDLZ) {
  name: '${baseName}-adf'
  scope: rgData
  params: {
    name: '${baseName}-adf'
    location: location
    tags: complianceTags
    managedVirtualNetworkEnabled: true
    publicNetworkAccess: 'Disabled'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── Data Management Landing Zone ────────────────────────────────────────────

module purview 'modules/purview.bicep' = if (deployDMLZ) {
  name: '${baseName}-prv'
  scope: rgManagement
  params: {
    name: '${baseName}-prv'
    location: location
    tags: complianceTags
    publicNetworkAccess: 'Disabled'
    managedResourceGroupName: 'rg-${baseName}-prv-managed'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── Streaming Infrastructure ────────────────────────────────────────────────

module eventHub 'modules/eventHub.bicep' = if (deployStreaming) {
  name: '${baseName}-eh'
  scope: rgStreaming
  params: {
    name: '${baseName}-eh'
    location: location
    tags: complianceTags
    sku: 'Standard'
    capacity: environment == 'prod' ? 4 : 1
    autoInflateEnabled: true
    maximumThroughputUnits: environment == 'prod' ? 20 : 4
    kafkaEnabled: true
    zoneRedundant: environment == 'prod'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module adx 'modules/dataExplorer.bicep' = if (deployStreaming) {
  name: '${baseName}-adx'
  scope: rgStreaming
  params: {
    name: '${baseName}-adx'
    location: location
    tags: complianceTags
    sku: environment == 'prod' ? 'Standard_E8as_v5+1TB_PS' : 'Dev(No SLA)_Standard_E2a_v4'
    enableDiskEncryption: true
    enableDoubleEncryption: enableFedRAMPHigh
    enableStreamingIngest: true
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── AI Services ─────────────────────────────────────────────────────────────

module openAI 'modules/openAI.bicep' = if (deployAIServices) {
  name: '${baseName}-aoai'
  scope: rgAI
  params: {
    name: '${baseName}-aoai'
    location: location
    tags: complianceTags
    sku: 'S0'
    publicNetworkAccess: 'Disabled'
    deployments: [
      {
        name: 'gpt-4o'
        model: 'gpt-4o'
        version: '2024-11-20'
        capacity: 30
      }
      {
        name: 'text-embedding-3-small'
        model: 'text-embedding-3-small'
        version: '1'
        capacity: 30
      }
    ]
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module mlWorkspace 'modules/machineLearning.bicep' = if (deployAIServices) {
  name: '${baseName}-ml'
  scope: rgAI
  params: {
    name: '${baseName}-ml'
    location: location
    tags: complianceTags
    keyVaultId: keyVault.outputs.keyVaultId
    storageAccountId: (deployDLZ && storage != null) ? storage!.outputs.storageAccountId : ''
    applicationInsightsId: ''
    publicNetworkAccess: 'Disabled'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── OSS Alternatives (AKS-hosted) ──────────────────────────────────────────

module aks 'modules/aks.bicep' = if (deployOSSAlternatives) {
  name: '${baseName}-aks'
  scope: rgOSS
  params: {
    name: '${baseName}-aks'
    location: location
    tags: complianceTags
    kubernetesVersion: '1.31'
    enableAzurePolicy: true
    enableDefender: true
    networkPlugin: 'azure'
    networkPolicy: 'calico'
    enablePrivateCluster: true
    systemNodePoolVmSize: 'Standard_D4s_v5'
    systemNodePoolCount: 3
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── RBAC — Service-to-Service Identity Wiring ─────────────────────────────
// Storage Blob Data Contributor: ba92f5b4-2d11-453d-a403-e96b0029c9fe

// ADF managed identity → Storage Blob Data Contributor on storage
resource roleAdfToStorage 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployDLZ) {
  name: guid(rgData.id, dataFactory.outputs.principalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: rgData
  properties: {
    principalId: dataFactory.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    description: 'ADF managed identity → Storage Blob Data Contributor on gov storage'
  }
}

// Databricks managed identity → Storage Blob Data Contributor on storage
resource roleDatabricksToStorage 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployDLZ) {
  name: guid(rgData.id, databricks.outputs.principalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: rgData
  properties: {
    principalId: databricks.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    description: 'Databricks managed identity → Storage Blob Data Contributor on gov storage'
  }
}

// Synapse managed identity → Storage Blob Data Contributor on storage
resource roleSynapseToStorage 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployDLZ) {
  name: guid(rgData.id, synapse.outputs.principalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: rgData
  properties: {
    principalId: synapse.outputs.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    description: 'Synapse managed identity → Storage Blob Data Contributor on gov storage'
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

output platformResourceGroup string = rgPlatform.name
output keyVaultName string = keyVault.outputs.keyVaultName
output logAnalyticsWorkspaceId string = logAnalytics.outputs.workspaceId
output govEndpoints object = govEndpoints
output complianceTags object = complianceTags
output dlzStorageAccountName string = (deployDLZ && storage != null) ? storage!.outputs.storageAccountName : ''
output databricksWorkspaceUrl string = (deployDLZ && databricks != null) ? databricks!.outputs.workspaceUrl : ''
output synapseWorkspaceUrl string = (deployDLZ && synapse != null) ? synapse!.outputs.workspaceUrl : ''
output eventHubNamespace string = (deployStreaming && eventHub != null) ? eventHub!.outputs.namespaceName : ''
output adxClusterUri string = (deployStreaming && adx != null) ? adx!.outputs.clusterUri : ''
output purviewAccountName string = (deployDMLZ && purview != null) ? purview!.outputs.accountName : ''
