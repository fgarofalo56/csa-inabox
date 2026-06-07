// CSA Loom deploy-planner — Azure Machine Learning workspace
//
// Wired by the deploy-planner catalog (key: mlWorkspace → mlWorkspaceEnabled).
// Self-contained: provisions the three required AML dependencies inline — a
// Key Vault, a Storage account, and an Application Insights component (backed by
// a Log Analytics workspace) — then an AML workspace (Microsoft.MachineLearning
// Services/workspaces) wired to them with a system-assigned identity. The Loom
// Console UAMI is granted AzureML Data Scientist so the navigator can drive the
// workspace data plane.
//
// Grounded in Microsoft Learn:
//   Microsoft.MachineLearningServices/workspaces (Bicep) + its KV/Storage/AppInsights deps
//   https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Tenant ID for the backing Key Vault.')
param tenantId string = subscription().tenantId

@description('Loom Console UAMI principal ID — granted AzureML Data Scientist so the BFF can drive the workspace data plane. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var suffix = uniqueString(resourceGroup().id)
var kvName = take('kv-aml-${suffix}', 24)
var saName = take('saamlloom${suffix}', 24)
var lawName = take('law-aml-loom-${suffix}', 63)
var aiName = take('appi-aml-loom-${suffix}', 255)
var wsName = take('aml-loom-${suffix}', 33)

// --- AML dependency 1: Key Vault ---
resource kv 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: kvName
  location: location
  tags: complianceTags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    publicNetworkAccess: 'Enabled'
  }
}

// --- AML dependency 2: Storage account ---
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: saName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

// --- AML dependency 3: Application Insights (workspace-based) ---
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: complianceTags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  tags: complianceTags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
  }
}

// --- AML workspace wired to the three deps ---
resource workspace 'Microsoft.MachineLearningServices/workspaces@2023-04-01' = {
  name: wsName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    friendlyName: 'CSA Loom ML workspace'
    keyVault: kv.id
    storageAccount: sa.id
    applicationInsights: appInsights.id
    publicNetworkAccess: 'Enabled'
  }
}

// AzureML Data Scientist — drive the workspace data plane
// (role f6c7c914-8db3-469d-8ca1-694a8f32e121).
resource amlDataScientist 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: workspace
  name: guid(workspace.id, consolePrincipalId, 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f6c7c914-8db3-469d-8ca1-694a8f32e121')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// AzureML Compute Operator — list / start / stop / restart Compute Instances
// on this workspace (role e503ece1-11d0-4e8e-8e2c-7a6c3bf38815). Mirrors the
// grant on the Foundry hub (ai-foundry.bicep) so the CI lifecycle routes
// (/api/foundry/computes[/{id}/start|status]) work against any AML workspace
// the Console drives. Data Scientist above lacks computes/*.
resource amlComputeOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: workspace
  name: guid(workspace.id, consolePrincipalId, 'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e503ece1-11d0-4e8e-8e2c-7a6c3bf38815')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output workspaceId string = workspace.id
output workspaceName string = workspace.name
