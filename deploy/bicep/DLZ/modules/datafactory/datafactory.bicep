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

@description('Resource ID of an existing Key Vault for linked service secrets.')
param keyVaultId string = ''

// Resources
resource dataFactory 'Microsoft.DataFactory/factories@2018-06-01' = {
  name: factoryName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess
    globalParameters: {}
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
      { category: 'ActivityRuns'; enabled: true }
      { category: 'PipelineRuns'; enabled: true }
      { category: 'TriggerRuns'; enabled: true }
      { category: 'SSISIntegrationRuntimeLogs'; enabled: true }
      { category: 'SSISPackageEventMessageContext'; enabled: true }
      { category: 'SSISPackageEventMessages'; enabled: true }
      { category: 'SSISPackageExecutableStatistics'; enabled: true }
      { category: 'SSISPackageExecutionComponentPhases'; enabled: true }
      { category: 'SSISPackageExecutionDataStatistics'; enabled: true }
      { category: 'SandboxActivityRuns'; enabled: true }
      { category: 'SandboxPipelineRuns'; enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics'; enabled: true }
    ]
  }
}

// Outputs
@description('Resource ID of the Data Factory.')
output factoryId string = dataFactory.id

@description('Name of the Data Factory.')
output factoryName string = dataFactory.name

@description('Managed identity principal ID of the Data Factory.')
output managedIdentityPrincipalId string = dataFactory.identity.principalId

@description('Managed identity tenant ID.')
output managedIdentityTenantId string = dataFactory.identity.tenantId
