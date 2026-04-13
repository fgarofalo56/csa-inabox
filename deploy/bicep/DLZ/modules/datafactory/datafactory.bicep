// Azure Data Factory Module
// Deploys ADF with managed virtual network, private endpoints, and diagnostic settings
targetScope = 'resourceGroup'

// Parameters
@description('Name of the Data Factory.')
param factoryName string

@description('Azure region for the factory.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Enable managed virtual network for the factory.')
param managedVirtualNetworkEnabled bool = true

@description('Public network access setting.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Disabled'

@description('Private endpoint subnet configurations.')
param privateEndpointSubnets array = []

@description('Private DNS Zone ID for Data Factory (privatelink.datafactory.azure.net).')
param privateDnsZoneIdDataFactory string = ''

@description('Private DNS Zone ID for Data Factory Portal (privatelink.adf.azure.com).')
param privateDnsZoneIdPortal string = ''

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock to the Data Factory. Default true for production safety.')
param enableResourceLock bool = true

@description('Resource ID of an existing Key Vault for linked service secrets.')
param keyVaultId string = ''

@description('Enable Customer-Managed Key (CMK) encryption.  Default false for dev; set true for prod/compliance.')
param parEnableCmk bool = false

@description('Key Vault URI (e.g. https://myvault.vault.azure.net) when CMK is enabled.')
param parCmkKeyVaultUri string = ''

@description('Key name in the Key Vault for CMK encryption.')
param parCmkKeyName string = ''

@description('Key version.  Leave empty for automatic key rotation (recommended).')
param parCmkKeyVersion string = ''

@description('Resource ID of the user-assigned managed identity for CMK.  Created by cmkIdentity.bicep.')
param parCmkIdentityId string = ''

@description('Resource ID of a Microsoft Purview account for automatic lineage collection.  When set, ADF pushes lineage metadata to Purview on every pipeline run.')
param purviewAccountId string = ''

// Resources
resource dataFactory 'Microsoft.DataFactory/factories@2018-06-01' = {
  name: factoryName
  location: location
  tags: tags
  identity: {
    type: parEnableCmk ? 'SystemAssigned,UserAssigned' : 'SystemAssigned'
    userAssignedIdentities: parEnableCmk ? {
      '${parCmkIdentityId}': {}
    } : null
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess
    purviewConfiguration: !empty(purviewAccountId) ? {
      purviewResourceId: purviewAccountId
    } : null
    globalParameters: {}
    encryption: parEnableCmk ? {
      vaultBaseUrl: parCmkKeyVaultUri
      keyName: parCmkKeyName
      keyVersion: !empty(parCmkKeyVersion) ? parCmkKeyVersion : ''
      identity: {
        userAssignedIdentity: parCmkIdentityId
      }
    } : null
  }
}

// Managed Virtual Network
resource managedVnet 'Microsoft.DataFactory/factories/managedVirtualNetworks@2018-06-01' = if (managedVirtualNetworkEnabled) {
  parent: dataFactory
  name: 'default'
  properties: {}
}

// AutoResolve Integration Runtime in managed VNet
resource autoResolveIr 'Microsoft.DataFactory/factories/integrationRuntimes@2018-06-01' = if (managedVirtualNetworkEnabled) {
  parent: dataFactory
  name: 'AutoResolveIntegrationRuntime'
  properties: {
    type: 'Managed'
    managedVirtualNetwork: {
      referenceName: 'default'
      type: 'ManagedVirtualNetworkReference'
    }
    typeProperties: {
      computeProperties: {
        location: 'AutoResolve'
        dataFlowProperties: {
          computeType: 'General'
          coreCount: 8
          timeToLive: 10
          cleanup: false
        }
      }
    }
  }
  dependsOn: [
    managedVnet
  ]
}

// Key Vault Linked Service
resource keyVaultLinkedService 'Microsoft.DataFactory/factories/linkedservices@2018-06-01' = if (!empty(keyVaultId)) {
  parent: dataFactory
  name: 'ls_KeyVault'
  properties: {
    type: 'AzureKeyVault'
    typeProperties: {
      baseUrl: 'https://${last(split(keyVaultId, '/'))}.vault.azure.net/'
    }
  }
}

// Private Endpoints - Data Factory
resource dataFactoryPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${factoryName}-df-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${factoryName}-dataFactory'
          properties: {
            privateLinkServiceId: dataFactory.id
            groupIds: [
              'dataFactory'
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

resource dataFactoryPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneIdDataFactory)) {
    parent: dataFactoryPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${factoryName}-df-dns'
          properties: {
            privateDnsZoneId: privateDnsZoneIdDataFactory
          }
        }
      ]
    }
  }
]

// Private Endpoints - Portal
resource portalPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: {
    name: '${factoryName}-portal-pe-${peSubnet.vNetName}'
    location: peSubnet.vNetLocation
    tags: tags
    properties: {
      privateLinkServiceConnections: [
        {
          name: '${factoryName}-portal'
          properties: {
            privateLinkServiceId: dataFactory.id
            groupIds: [
              'portal'
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

resource portalPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [
  for (peSubnet, index) in privateEndpointSubnets: if (!empty(privateDnsZoneIdPortal)) {
    parent: portalPrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: '${factoryName}-portal-dns'
          properties: {
            privateDnsZoneId: privateDnsZoneIdPortal
          }
        }
      ]
    }
  }
]

// Diagnostic Settings
resource dataFactoryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${factoryName}-diagnostics'
  scope: dataFactory
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'ActivityRuns', enabled: true }
      { category: 'PipelineRuns', enabled: true }
      { category: 'TriggerRuns', enabled: true }
      { category: 'SSISIntegrationRuntimeLogs', enabled: true }
      { category: 'SSISPackageEventMessageContext', enabled: true }
      { category: 'SSISPackageEventMessages', enabled: true }
      { category: 'SSISPackageExecutableStatistics', enabled: true }
      { category: 'SSISPackageExecutionComponentPhases', enabled: true }
      { category: 'SSISPackageExecutionDataStatistics', enabled: true }
      { category: 'SandboxActivityRuns', enabled: true }
      { category: 'SandboxPipelineRuns', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — protects the Data Factory from accidental deletion.
resource dataFactoryLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: dataFactory
  name: '${factoryName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: Data Factory. Remove lock before deleting.'
  }
}

// Outputs
output factoryId string = dataFactory.id

@description('Name of the Data Factory.')
output factoryName string = dataFactory.name

@description('Managed identity principal ID of the Data Factory.')
output managedIdentityPrincipalId string = dataFactory.identity.principalId

@description('Managed identity tenant ID.')
output managedIdentityTenantId string = dataFactory.identity.tenantId
