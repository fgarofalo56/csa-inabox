// Azure Machine Learning Workspace Module
// Deploys AML workspace with private endpoints, compute, and diagnostic settings
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Azure ML workspace.')
param workspaceName string

@description('Azure region for the workspace.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Resource ID of the Storage Account for the workspace.')
param storageAccountId string

@description('Resource ID of the Key Vault for the workspace.')
param keyVaultId string

@description('Resource ID of the Application Insights instance.')
param applicationInsightsId string

@description('Resource ID of the Container Registry (optional).')
param containerRegistryId string = ''

@description('Public network access setting.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('SKU name for the workspace.')
@allowed([
  'Basic'
  'Enterprise'
])
param skuName string = 'Basic'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID for AML workspace (privatelink.api.azureml.ms).')
param privateDnsZoneIdApi string = ''

@description('Private DNS Zone ID for AML notebooks (privatelink.notebooks.azure.net).')
param privateDnsZoneIdNotebooks string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock to the AML workspace. Default true for production safety.')
param enableResourceLock bool = true

@description('Deploy a default compute instance.')
param deployCompute bool = false

@description('VM size for compute instance.')
param computeVmSize string = 'Standard_DS3_v2'

@description('Enable Customer-Managed Key (CMK) encryption.  Default false for dev; set true for prod/compliance.')
param parEnableCmk bool = false

@description('Resource ID of the Key Vault for CMK encryption (e.g. /subscriptions/.../Microsoft.KeyVault/vaults/myvault).')
param parCmkKeyVaultId string = ''

@description('Full key identifier URI for CMK encryption (e.g. https://myvault.vault.azure.net/keys/mykey/version).')
param parCmkKeyIdentifier string = ''

@description('Resource ID of the user-assigned managed identity for CMK.  Created by cmkIdentity.bicep.')
param parCmkIdentityId string = ''

// Resources
// #checkov:skip=CKV_AZURE_144:AML workspace CMK encryption is optional for dev/lab — enable via parEnableCmk for prod
resource amlWorkspace 'Microsoft.MachineLearningServices/workspaces@2024-04-01' = {
  name: workspaceName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuName
  }
  identity: {
    type: parEnableCmk ? 'SystemAssigned,UserAssigned' : 'SystemAssigned'
    userAssignedIdentities: parEnableCmk ? {
      '${parCmkIdentityId}': {}
    } : null
  }
  properties: {
    friendlyName: workspaceName
    storageAccount: storageAccountId
    keyVault: keyVaultId
    applicationInsights: applicationInsightsId
    containerRegistry: !empty(containerRegistryId) ? containerRegistryId : null
    publicNetworkAccess: publicNetworkAccess
    managedNetwork: {
      isolationMode: 'AllowOnlyApprovedOutbound'
    }
    v1LegacyMode: false
    encryption: parEnableCmk ? {
      status: 'Enabled'
      keyVaultProperties: {
        keyVaultArmId: parCmkKeyVaultId
        keyIdentifier: parCmkKeyIdentifier
      }
      identity: {
        userAssignedIdentity: parCmkIdentityId
      }
    } : null
    primaryUserAssignedIdentity: parEnableCmk ? parCmkIdentityId : null
  }
}

// Compute Instance (optional)
resource computeInstance 'Microsoft.MachineLearningServices/workspaces/computes@2024-04-01' = if (deployCompute) {
  parent: amlWorkspace
  name: '${workspaceName}-ci-01'
  location: location
  properties: {
    computeType: 'ComputeInstance'
    properties: {
      vmSize: computeVmSize
      applicationSharingPolicy: 'Personal'
      sshSettings: {
        sshPublicAccess: 'Disabled'
      }
      idleTimeBeforeShutdown: 'PT30M'
    }
  }
}

// Private Endpoints - API
resource amlPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${workspaceName}-aml-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${workspaceName}-amlworkspace'
          properties: {
            privateLinkServiceId: amlWorkspace.id
            groupIds: [
              'amlworkspace'
            ]
          }
        }
      ]
      subnet: {
        id: resourceId(
          peSubnet.subscriptionId,
          peSubnet.vNetResourceGroup,
          'Microsoft.Network/virtualNetworks/subnets',
          peSubnet.vNetName,
          peSubnet.subnetName
        )
      }
    }
  }
]

resource amlPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneIdApi)) {
    parent: amlPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${workspaceName}-api-dns'
          properties: {
            privateDnsZoneId: privateDnsZoneIdApi
          }
        }
        {
          name: '${workspaceName}-notebooks-dns'
          properties: {
            privateDnsZoneId: !empty(privateDnsZoneIdNotebooks) ? privateDnsZoneIdNotebooks : privateDnsZoneIdApi
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource amlDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${workspaceName}-diagnostics'
  scope: amlWorkspace
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'AmlComputeClusterEvent', enabled: true }
      { category: 'AmlComputeClusterNodeEvent', enabled: true }
      { category: 'AmlComputeJobEvent', enabled: true }
      { category: 'AmlComputeCpuGpuUtilization', enabled: true }
      { category: 'AmlRunStatusChangedEvent', enabled: true }
      { category: 'ModelsChangeEvent', enabled: true }
      { category: 'ModelsReadEvent', enabled: true }
      { category: 'ModelsActionEvent', enabled: true }
      { category: 'DeploymentReadEvent', enabled: true }
      { category: 'DeploymentEventACI', enabled: true }
      { category: 'DeploymentEventAKS', enabled: true }
      { category: 'InferencingOperationAKS', enabled: true }
      { category: 'EnvironmentChangeEvent', enabled: true }
      { category: 'EnvironmentReadEvent', enabled: true }
      { category: 'DataLabelChangeEvent', enabled: true }
      { category: 'DataLabelReadEvent', enabled: true }
      { category: 'ComputeInstanceEvent', enabled: true }
      { category: 'DataStoreChangeEvent', enabled: true }
      { category: 'DataStoreReadEvent', enabled: true }
      { category: 'DataSetChangeEvent', enabled: true }
      { category: 'DataSetReadEvent', enabled: true }
      { category: 'PipelineChangeEvent', enabled: true }
      { category: 'PipelineReadEvent', enabled: true }
      { category: 'RunEvent', enabled: true }
      { category: 'RunReadEvent', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — protects the AML workspace from accidental deletion.
resource amlLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: amlWorkspace
  name: '${workspaceName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: Azure ML workspace. Remove lock before deleting.'
  }
}

// Outputs
output workspaceId string = amlWorkspace.id

@description('Name of the AML workspace.')
output workspaceName string = amlWorkspace.name

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = amlWorkspace.identity.principalId

@description('Discovery URL for the workspace.')
output discoveryUrl string = amlWorkspace.properties.discoveryUrl
