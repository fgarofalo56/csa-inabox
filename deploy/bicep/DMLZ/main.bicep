// Main Bicep File for setting up the landing zone
targetScope = 'subscription'

// Metadata
metadata name = 'DMLZ Bicep - Main Resources Deployment'
metadata description = 'Modules used to deploy Azure Resouces for Azure Data Management Landing Zone'

// General parameters
// Specify the location for all resources.
@allowed([
  'EastUS'
  'EastUS2'
  'East US'
  'East US 2'
  'WestUS'
  'WestUS2'
  'CentralUS'
  'SouthCentralUS'
  'WestCentralUS'
  'NorthCentralUS'
  'usgovvirginia'
  'usgoviowa'
  'usgovarizona'
  'usgovtexas'
  'US Gov Virginia'
  'US Gov Iowa'
  'US Gov Arizona'
  'US Gov Texas'
])
@description('Specify the location for all resources.')
param location string

// Specify the environment of the deployment.
@allowed([
  'dev'
  'tst'
  'uat'
  'stg'
  'prod'
])
@description('Specify the environment of the deployment.')
param environment string = 'dev'

//Moddules and Resources to deploy
@description('Specify the modules and resources to deploy')
param deployModules object = {}

// Tags to add
@description('Specifies the tags that you want to apply to all resources.')
param tags object = {}

// Specify the prefix for all resources.
@description('Specify the prefix for all resources.')
@minLength(2)
@maxLength(10)
param prefix string = 'admlz'

// Parameter to build base name for resources to include prefix and environment
@sys.description('Parameter to build base name for resources to include prefix and environment')
param parBaseName string = toLower('${prefix}-${environment}')

// Private DNS Zone Information
@description('Private DNS Zone Information')
param privateDNSZones object

// Governance module parameters
@sys.description('Array to hold all vaules for Governance module.')
param parGovernance object

// Default tags
var tagsDefault = {
  Owner: 'Azure Data Management Landing Zone & Cloud Scale Analytics Scenario'
  Project: 'Azure Demo DMLZ & CSA'
  environment: environment
  Toolkit: 'Bicep'
  PrimaryContact: 'frgarofa'
  CostCenter: 'FFL ATU - ExampleDataCostCenter-12345'
}

// Union of default tags and user-defined tags
var tagsJoined = union(tagsDefault, tags)

// Governance Variables

var varRGGovernanceTags = union(tagsDefault, parGovernance.rgTags)

var parLocationShort = toLower(replace(location, ' ', ''))

/***************************************************************************************************************************************************
Resource Modules and Deployments
***************************************************************************************************************************************************/

// Governance Modules
// Deploy Resource Group
// module purviewResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (bool(deployModules.governance)) {
//   name: 'DeployPurviewResourceGroup'
//   scope: subscription()
//   params: {
//     parLocation: parGovernance.parLocation
//     // parResourceGroupName: 'rg-${parBaseName}-governance-${parGovernance.parLocation}'
//     parResourceGroupName: 'frgaofa-purview-dev'
//     parTags: tagsJoined
//   }
// }

// //Deploy Purview
// module deployPurview 'modules/Purview/purview.bicep' = if (bool(deployModules.governance)) {
//   name: 'Deploy-Purview-${parGovernance.parLocation}'
//   // scope: resourceGroup('rg-${parBaseName}-governance-${parGovernance.parLocation}')
//   scope: resourceGroup('frgaofa-purview-dev')
//   params: {
//     // purviewAcctName: '${parBaseName}-purview-${parGovernance.parLocation}'
//     purviewAcctName: 'dmz-purview'
//     sku: parGovernance.parPurviewSku
//     publicNetworkAccess: parGovernance.parPurviewPublicNetworkAccess
//     location: parGovernance.parLocation
//     parTenantEndpointState: parGovernance.parTenantEndpointState
//     configKafka: parGovernance.parPurviewKafkaConfig
//     tags: parGovernance.tags
//   }
//   dependsOn: [
//     purviewResourceGroup
//   ]
// }

// Governance resources
resource governanceResourceGroup 'Microsoft.Resources/resourceGroups@2021-01-01' = if (bool(deployModules.governance)) {
  name: 'rg-${parBaseName}-governance-${parLocationShort}'
  location: location
  tags: varRGGovernanceTags
  properties: {}
}

module governanceResources 'modules/governance/governance.bicep' = if (bool(deployModules.governance)) {
  name: 'governanceResources'
  scope: resourceGroup('rg-${parBaseName}-governance-${parLocationShort}')
  params: {
    location: location
    governanceResourceGroup: 'rg-${parBaseName}-governance-${parLocationShort}'
    prefix: prefix
    environment: environment
    parGovernance: parGovernance
    deployModules: deployModules
    defaultTags: tagsDefault
  }
  dependsOn: [
    governanceResourceGroup
  ]
}

// // Container resources
// resource containerResourceGroup 'Microsoft.Resources/resourceGroups@2021-01-01' = {
//   name: '${name}-container'
//   location: location
//   tags: tagsJoined
//   properties: {}
// }

// module containerResources 'modules/container.bicep' = {
//   name: 'containerResources'
//   scope: containerResourceGroup
//   params: {
//     location: location
//     prefix: name
//     tags: tagsJoined
//     subnetId: networkServices.outputs.serviceSubnet
//     privateDnsZoneIdContainerRegistry: enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdContainerRegistry : privateDnsZoneIdContainerRegistry
//   }
// }

// // Consumption resources
// resource consumptionResourceGroup 'Microsoft.Resources/resourceGroups@2021-01-01' = {
//   name: '${name}-consumption'
//   location: location
//   tags: tagsJoined
//   properties: {}
// }

// module consumptionResources 'modules/consumption.bicep' = {
//   name: 'consumptionResources'
//   scope: consumptionResourceGroup
//   params: {
//     location: location
//     prefix: name
//     tags: tagsJoined
//     subnetId: networkServices.outputs.serviceSubnet
//     privateDnsZoneIdSynapseprivatelinkhub: enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdSynapse : privateDnsZoneIdSynapse
//     privateDnsZoneIdAnalysis: enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdAnalysis : ''
//     privateDnsZoneIdPbiDedicated: enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdPbiDedicated : ''
//     privateDnsZoneIdPowerQuery: enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdPowerQuery : ''
//   }
// }

// // Automation services
// resource automationResourceGroup 'Microsoft.Resources/resourceGroups@2021-01-01' = {
//   name: '${name}-automation'
//   location: location
//   tags: tagsJoined
//   properties: {}
// }

// module automationResources 'modules/automation.bicep' = {
//   name: 'automationResources'
//   scope: automationResourceGroup
//   params: {
//     location: location
//     tags: tagsJoined
//     prefix: name
//     purviewId: governanceResources.outputs.purviewId
//     purviewRootCollectionAdminObjectIds: purviewRootCollectionAdminObjectIds
//   }
// }

// // Management services
// resource managementResourceGroup 'Microsoft.Resources/resourceGroups@2021-01-01' = {
//   name: '${name}-mgmt'
//   location: location
//   tags: tagsJoined
//   properties: {}
// }

// // Outputs
// output vnetId string = networkServices.outputs.vnetId
// output firewallPrivateIp string = networkServices.outputs.firewallPrivateIp
// output purviewId string = governanceResources.outputs.purviewId
// output purviewManagedStorageId string = governanceResources.outputs.purviewManagedStorageId
// output purviewManagedEventHubId string = governanceResources.outputs.purviewManagedEventHubId
// output privateDnsZoneIdKeyVault string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdKeyVault : ''
// output privateDnsZoneIdDataFactory string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdDataFactory : ''
// output privateDnsZoneIdDataFactoryPortal string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdDataFactoryPortal : ''
// output privateDnsZoneIdBlob string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdBlob : ''
// output privateDnsZoneIdDfs string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdDfs : ''
// output privateDnsZoneIdSqlServer string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdSqlServer : ''
// output privateDnsZoneIdMySqlServer string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdMySqlServer : ''
// output privateDnsZoneIdNamespace string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdNamespace : ''
// output privateDnsZoneIdSynapseDev string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdSynapseDev : ''
// output privateDnsZoneIdSynapseSql string = enableDnsAndFirewallDeployment ? globalDnsZones.outputs.privateDnsZoneIdSynapseSql : ''
