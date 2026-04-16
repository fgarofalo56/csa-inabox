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

//Modules and Resources to deploy
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
param basename string = toLower('${prefix}-${environment}')

// Private DNS Zone Information
@description('Private DNS Zone Information')
param privateDNSZones object

// Governance module parameters
@sys.description('Array to hold all vaules for Governance module.')
param parGovernance object

// Databricks governance workspace parameters
@description('Parameters for governance Databricks workspace (Unity Catalog)')
param parDatabricks object = {}

// Log Analytics Workspace ID for diagnostics
@description('Resource ID of the Log Analytics workspace for diagnostics')
param logAnalyticsWorkspaceId string = ''

@description('Primary technical contact for deployed resources. Must be set to a valid address before deployment.')
param primaryContact string = ''

@description('Cost center or billing code for deployed resources.')
param costCenter string = 'CSA-Platform'

// Default tags
var tagsDefault = {
  Owner: 'Azure Data Management Landing Zone & Cloud Scale Analytics Scenario'
  Project: 'Azure Demo DMLZ & CSA'
  environment: environment
  Toolkit: 'Bicep'
  PrimaryContact: primaryContact
  CostCenter: costCenter
}

// Union of default tags and user-defined tags
var tagsJoined = union(tagsDefault, tags)

// Governance Variables

var varRGGovernanceTags = union(tagsDefault, parGovernance.rgTags)

var parLocationShort = toLower(replace(location, ' ', ''))

/***************************************************************************************************************************************************
Resource Modules and Deployments
***************************************************************************************************************************************************/

// Governance resources
resource governanceResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = if (bool(deployModules.governance)) {
  name: 'rg-${basename}-governance-${parLocationShort}'
  location: location
  tags: varRGGovernanceTags
  properties: {}
}

module governanceResources 'modules/governance/governance.bicep' = if (bool(deployModules.governance)) {
  name: 'governanceResources'
  scope: resourceGroup('rg-${basename}-governance-${parLocationShort}')
  params: {
    location: location
    governanceResourceGroup: 'rg-${basename}-governance-${parLocationShort}'
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

// Deploy Governance Databricks Workspace (Unity Catalog)
resource databricksResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = if (contains(deployModules, 'databricks') && bool(deployModules.databricks)) {
  name: 'rg-${basename}-databricks-gov-${parLocationShort}'
  location: location
  tags: tagsJoined
  properties: {}
}

module databricksGovernance 'modules/Databricks/databricks.bicep' = if (contains(deployModules, 'databricks') && bool(deployModules.databricks)) {
  name: 'databricksGovernance'
  scope: resourceGroup('rg-${basename}-databricks-gov-${parLocationShort}')
  params: {
    workspaceName: contains(parDatabricks, 'workspaceName') ? parDatabricks.workspaceName : '${basename}-dbw-gov'
    location: location
    tags: tagsJoined
    vnetId: contains(parDatabricks, 'vnetId') ? parDatabricks.vnetId : ''
    publicSubnetName: contains(parDatabricks, 'publicSubnetName') ? parDatabricks.publicSubnetName : 'databricks-gov-public'
    privateSubnetName: contains(parDatabricks, 'privateSubnetName') ? parDatabricks.privateSubnetName : 'databricks-gov-private'
    privateEndpointSubnets: contains(parDatabricks, 'privateEndpointSubnets') ? parDatabricks.privateEndpointSubnets : []
    privateDnsZoneId: contains(parDatabricks, 'privateDnsZoneId') ? parDatabricks.privateDnsZoneId : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    databricksResourceGroup
  ]
}

// Outputs — Governance & Databricks Resource IDs
output governanceResourceGroupName string = bool(deployModules.governance) ? governanceResourceGroup.name : ''
output databricksGovernanceWorkspaceId string = contains(deployModules, 'databricks') && bool(deployModules.databricks) ? databricksGovernance.outputs.workspaceId : ''
output databricksGovernanceWorkspaceUrl string = contains(deployModules, 'databricks') && bool(deployModules.databricks) ? databricksGovernance.outputs.workspaceUrl : ''
