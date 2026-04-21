// -------------------------------------------------------------
// CSA-0115 ml-lifecycle — Azure ML Workspace + online endpoint
//
// Deploys:
//   * Azure Storage (ADLS Gen2) for AML artifacts + training data
//   * Azure Key Vault for AML secrets
//   * Azure Application Insights for AML telemetry
//   * Azure ML Workspace + managed online endpoint
//
// FedRAMP target: moderate
// Reuses the shared bicep module pattern from
//   deploy/bicep/DLZ/modules/machinelearning/machinelearning.bicep
// without hard-linking (bicep modules can't be relative across repos).
// -------------------------------------------------------------

targetScope = 'resourceGroup'

// ------------------------ Parameters ------------------------

@description('Base name prefix for all resources (lowercase, 3-20 chars).')
@minLength(3)
@maxLength(20)
param baseName string = 'csamllife'

@description('Azure region — default is the resource group region.')
param location string = resourceGroup().location

@description('Environment name (dev / test / prod).')
@allowed([ 'dev', 'test', 'prod' ])
param environment string = 'dev'

@description('Workspace SKU.')
@allowed([ 'Basic', 'Enterprise' ])
param workspaceSku string = 'Basic'

@description('Object ID of the AAD group granted Contributor on the workspace.')
param workspaceAdminObjectId string = ''

@description('Log Analytics workspace ID for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {
  vertical: 'ml-lifecycle'
  environment: environment
  source: 'csa-inabox/examples/ml-lifecycle'
  contract: 'loan_training_features.yaml'
}

// ------------------------ Naming ----------------------------

var storageName = '${baseName}st${uniqueString(resourceGroup().id)}'
var kvName      = '${baseName}kv${uniqueString(resourceGroup().id)}'
var appiName    = '${baseName}-appi-${environment}'
var amlName     = '${baseName}-aml-${environment}'
var endpointName = '${baseName}-loan-default-${environment}'
var deploymentName = 'blue'

// ------------------------ Storage ---------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    isHnsEnabled: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true    // AML still needs this for artifact uploads
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
    encryption: {
      services: {
        blob: { enabled: true }
        file: { enabled: true }
      }
      keySource: 'Microsoft.Storage'
    }
  }
}

// ------------------------ Key Vault -------------------------

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: true
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// ------------------------ App Insights ----------------------

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: appiName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: empty(logAnalyticsWorkspaceId) ? null : logAnalyticsWorkspaceId
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// ------------------------ Azure ML --------------------------

resource aml 'Microsoft.MachineLearningServices/workspaces@2024-04-01' = {
  name: amlName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: workspaceSku
    tier: workspaceSku
  }
  properties: {
    friendlyName: '${baseName} loan-default workspace (${environment})'
    storageAccount: storage.id
    keyVault: keyVault.id
    applicationInsights: appi.id
    publicNetworkAccess: 'Enabled'
    hbiWorkspace: false
  }
}

// ------------------------ Online endpoint -------------------

resource endpoint 'Microsoft.MachineLearningServices/workspaces/onlineEndpoints@2024-04-01' = {
  parent: aml
  name: endpointName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  kind: 'Managed'
  properties: {
    authMode: 'Key'
    description: 'Loan-default online inference endpoint (CSA-0115)'
    publicNetworkAccess: 'Enabled'
    traffic: {
      '${deploymentName}': 100
    }
  }
}

// ------------------------ RBAC ------------------------------

resource amlContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(workspaceAdminObjectId)) {
  name: guid(resourceGroup().id, workspaceAdminObjectId, 'aml-contributor')
  scope: aml
  properties: {
    // AzureML Data Scientist built-in role
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
    principalId: workspaceAdminObjectId
    principalType: 'User'
  }
}

// ------------------------ Outputs ---------------------------

output workspaceName string = aml.name
output workspaceId string = aml.id
output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output appInsightsName string = appi.name
output endpointName string = endpoint.name
