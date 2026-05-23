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
resource hubOwnerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryHub
  name: guid(foundryHub.id, adminEntraGroupId, 'aml-owner')
  properties: {
    // AzureML Data Scientist
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'f6c7c914-8db3-469d-8ca1-694a8f32e121')
    principalId: adminEntraGroupId
    principalType: 'Group'
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

output hubId string = foundryHub.id
output hubName string = foundryHub.name
output hubKind string = workspaceKind
output hubManagedIdentityPrincipalId string = foundryHub.identity.principalId
