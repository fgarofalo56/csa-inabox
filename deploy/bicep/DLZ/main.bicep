// Main Bicep File for setting up the landing zone
targetScope = 'subscription'

// Metadata
metadata name = 'DLZ Bicep - Data Landing Zone Subscription Deployment'
metadata description = 'Modules and resources to deploy the Data Landing Zone in a subscription'

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
@minLength(2)
param environment string = 'dev'

// Modules and Resources to deploy
@description('Specify the modules and resources to deploy')
param deployModules object = {}

// Specify the prefix for all resources.
@description('Specify the prefix for all resources.')
@minLength(2)
@maxLength(10)
param prefix string = 'dlz'

@sys.description('Parameter to build base name for resources to include prefix and environment')
@minLength(4)
param basename string = toLower('${prefix}-${environment}')

// Private DNS Zone Information
@description('Private DNS Zone Information')
param privateDNSZones object

// Cosmos DB parameters
@description('Cosmos DB parameters')
param parCosmosDB object

// Storage parameters
@description('Storage parameters')
param parStorage object

// External Storage parameters
@description('External Storage parameters')
param parExternalStorage object

// Synapse parameters
@description('Synapse parameters')
param parSynapse object

// Databricks parameters
@description('Databricks workspace parameters')
param parDatabricks object = {}

// Data Factory parameters
@description('Azure Data Factory parameters')
param parDataFactory object = {}

// Event Hubs parameters
@description('Event Hubs namespace parameters')
param parEventHubs object = {}

// Machine Learning parameters
@description('Azure Machine Learning workspace parameters')
param parMachineLearning object = {}

// Data Explorer parameters
@description('Azure Data Explorer (Kusto) cluster parameters')
param parDataExplorer object = {}

// Functions parameters
@description('Azure Functions parameters')
param parFunctions object = {}

// Stream Analytics parameters
@description('Stream Analytics job parameters')
param parStreamAnalytics object = {}

// Application Insights parameters
@description('Application Insights parameters')
param parAppInsights object = {}

// Storage (generic) parameters
@description('Generic storage account parameters (separate from lake zones)')
param parGenericStorage object = {}

// Self-Hosted Integration Runtime parameters
@description('Self-Hosted Integration Runtime VM Scale Set parameters')
param parSelfHostedIR object = {}

@secure()
@description('SQL admin password for Synapse workspace. Prefer Key Vault reference over plaintext.')
param synapseSqlAdminPassword string = ''

@secure()
@description('Administrator password for Self-Hosted Integration Runtime VMSS.')
param shirAdminPassword string = ''

@secure()
@description('Data Factory Integration Runtime authentication key for SHIR.')
param shirAuthKey string = ''

// Private Endpoints parameters
@description('Private Endpoints configuration parameters')
param parPrivateEndpoints object = {}

// Log Analytics Workspace ID for diagnostics
@description('Resource ID of the Log Analytics workspace for diagnostics across all services')
param logAnalyticsWorkspaceId string = ''

@description('Primary technical contact for deployed resources.')
param primaryContact string = 'platform-team@contoso.com'

@description('Cost center or billing code for deployed resources.')
param costCenter string = 'CSA-Platform'

//  Variables
// Default tags
var tagsDefault = {
  Owner: 'Azure Landing Zone & Cloud Scale Analytics Scenario'
  Project: 'Azure Demo ALZ & CSA'
  environment: environment
  Toolkit: 'Bicep'
  PrimaryContact: primaryContact
  CostCenter: costCenter
}
var parLocationShort = toLower(replace(location, ' ', ''))

// Cosmos DB Variables
var varCosmosTags = union(tagsDefault, parCosmosDB.tags)

// Storage Variables
var varStorageTags = union(tagsDefault, parStorage.tags)

// External Storage Variables
var varExternalStorageTags = union(tagsDefault, parExternalStorage.tags)

// Synapse Variables
var varSynapseTags = union(tagsDefault, parSynapse.tags)

/***************************************************************************************************************************************************
Resource Modules and Deployments
***************************************************************************************************************************************************/

// Cosmos DB RG
module cosmosdbresourcegroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'cosmosDB') && bool(deployModules.cosmosDB)) {
  name: 'deployCosmosDbRg'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-cosmosdb-${parLocationShort}'
    parTags: varCosmosTags
  }
}

// Cosmos DB Module
module cosmosdb 'modules/cosmos/cosmosdb.bicep' = if (contains(deployModules, 'cosmosDB') && bool(deployModules.cosmosDB)) {
  name: 'DeployCosmosDb'
  scope: resourceGroup('rg-${basename}-cosmosdb-${parLocationShort}')
  params: {
    parLocation: location
    cosmosDbAccountName: toLower('${basename}-${parCosmosDB.cosmosDbAccountName}-${parLocationShort}')
    defaultDatabaseName: parCosmosDB.defaultDatabaseName
    enableAutomaticFailover: parCosmosDB.enableAutomaticFailover == 'Enabled'
    enableMultipleWriteLocations: parCosmosDB.enableMultipleWriteLocations == 'Enabled'
    enableAnalyticalStorage: parCosmosDB.enableAnalyticalStorage == 'Enabled'
    enableFreeTier: parCosmosDB.enableFreeTier
    enableMaterializedViews: parCosmosDB.enableMaterializedViews
    enableBurstCapacity: parCosmosDB.enableBurstCapacity
    enableCassandraConnector: parCosmosDB.enableCassandraConnector
    enablePartitionMerge: parCosmosDB.enablePartitionMerge
    enablePerRegionPerPartitionAutoscale: parCosmosDB.enablePerRegionPerPartitionAutoscale
    enablePriorityBasedExecution: parCosmosDB.enablePriorityBasedExecution
    disableKeyBasedMetadataWriteAccess: parCosmosDB.disableKeyBasedMetadataWriteAccess
    disableLocalAuth: parCosmosDB.disableLocalAuth
    consistencyLevel: parCosmosDB.consistencyLevel
    backupPolicyType: parCosmosDB.backupPolicyType
    backupIntervalInMinutes: parCosmosDB.backupIntervalInMinutes
    backupRetentionInHours: parCosmosDB.backupRetentionInHours
    continuousBackupTier: parCosmosDB.continuousBackupTier
    publicNetworkAccess: parCosmosDB.publicNetworkAccess
    networkAclBypass: parCosmosDB.networkAclBypass
    ipRules: parCosmosDB.ipRules
    virtualNetworkRules: parCosmosDB.virtualNetworkRules
    tags: varCosmosTags
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    cosmosdbresourcegroup
  ]
}

// Storage Resources:
module storageResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'storageZones') && bool(deployModules.storageZones)) {
  name: 'rg-${basename}-storage-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-storage-${parLocationShort}'
    parTags: varStorageTags
  }
}

module storageServices 'modules/storage/lakezones.bicep' = if (contains(deployModules, 'storageZones') && bool(deployModules.storageZones)) {
  name: 'storageServices'
  scope: resourceGroup('rg-${basename}-storage-${parLocationShort}')
  params: {
    location: location
    prefix: prefix
    storageAccountName: parStorage.storageAccountName
    privateEndpointSubnets: parStorage.privateEndpointSubnets
    privateDNSZones: privateDNSZones
    domainFileSystemNames: parStorage.domainFileSystemNames
    dataProductFileSystemNames: parStorage.dataProductFileSystemNames
    tags: varStorageTags
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    enableResourceLock: contains(parStorage, 'enableResourceLock') ? parStorage.enableResourceLock : true
  }
  dependsOn: [
    storageResourceGroup
  ]
}

// External storage resources
// External Storage Resource Group
module externalStorageResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'externalStorage') && bool(deployModules.externalStorage)) {
  name: 'rg-${basename}-externalstorage-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-externalstorage-${parLocationShort}'
    parTags: varExternalStorageTags
  }
}

// External Storage Module
// Check for Private DNS Zone ID for Blob

// External Storage Module
module externalStorageServices 'modules/storage/externalstorageMain.bicep' = if (contains(deployModules, 'externalStorage') && bool(deployModules.externalStorage)) {
  name: 'externalStorageServices'
  scope: resourceGroup('rg-${basename}-externalstorage-${parLocationShort}')
  params: {
    location: location
    prefix: prefix
    storageAccountName: parExternalStorage.storageAccountName
    privateEndpointSubnets: parExternalStorage.privateEndpointSubnets
    privateDNSZones: privateDNSZones
    tags: varExternalStorageTags
  }
  dependsOn: [
    externalStorageResourceGroup
  ]
}

// Deploy Azure Synapse Analytics
module synapseResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'synapse') && bool(deployModules.synapse)) {
  name: 'rg-${basename}-synapse-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-synapse-${parLocationShort}'
    parTags: varSynapseTags
  }
}

module synapseWorkspace 'modules/synapse/synapse.bicep' = if (contains(deployModules, 'synapse') && bool(deployModules.synapse)) {
  name: 'synapseWorkspace'
  scope: resourceGroup('rg-${basename}-synapse-${parLocationShort}')
  params: {
    location: location
    tags: varSynapseTags
    synapseName: contains(parSynapse, 'synapseWorkspaceName') ? parSynapse.synapseWorkspaceName : '${basename}-synapse'
    administratorUsername: contains(parSynapse, 'sqlAdminUsername') ? parSynapse.sqlAdminUsername : 'synadmin_${uniqueString(subscription().subscriptionId)}'
    administratorPassword: synapseSqlAdminPassword != '' ? synapseSqlAdminPassword : (contains(parSynapse, 'sqlAdminPassword') ? parSynapse.sqlAdminPassword : '')
    synapseDefaultStorageAccountFileSystemId: storageServices.outputs.storageWorkspaceFileSystemId
    privateEndpointSubnets: contains(parSynapse, 'privateEndpointSubnets') ? parSynapse.privateEndpointSubnets : parStorage.privateEndpointSubnets
  }
  dependsOn: [
    synapseResourceGroup
    storageServices
  ]
}

// Deploy Azure Databricks
module databricksResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'databricks') && bool(deployModules.databricks)) {
  name: 'rg-${basename}-databricks-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-databricks-${parLocationShort}'
    parTags: tagsDefault
  }
}

module databricksWorkspace 'modules/databricks/databricks.bicep' = if (contains(deployModules, 'databricks') && bool(deployModules.databricks)) {
  name: 'databricksWorkspace'
  scope: resourceGroup('rg-${basename}-databricks-${parLocationShort}')
  params: {
    workspaceName: contains(parDatabricks, 'workspaceName') ? parDatabricks.workspaceName : '${basename}-dbw'
    location: location
    tags: tagsDefault
    pricingTier: contains(parDatabricks, 'pricingTier') ? parDatabricks.pricingTier : 'premium'
    enableNoPublicIp: contains(parDatabricks, 'enableNoPublicIp') ? parDatabricks.enableNoPublicIp : true
    vnetId: contains(parDatabricks, 'vnetId') ? parDatabricks.vnetId : ''
    publicSubnetName: contains(parDatabricks, 'publicSubnetName') ? parDatabricks.publicSubnetName : 'databricks-public'
    privateSubnetName: contains(parDatabricks, 'privateSubnetName') ? parDatabricks.privateSubnetName : 'databricks-private'
    privateEndpointSubnets: contains(parDatabricks, 'privateEndpointSubnets') ? parDatabricks.privateEndpointSubnets : []
    privateDnsZoneId: contains(parDatabricks, 'privateDnsZoneId') ? parDatabricks.privateDnsZoneId : ''
    parEnableCmk: contains(parDatabricks, 'enableCmk') ? parDatabricks.enableCmk : false
    parCmkKeyVaultUri: contains(parDatabricks, 'cmkKeyVaultUri') ? parDatabricks.cmkKeyVaultUri : ''
    parCmkKeyName: contains(parDatabricks, 'cmkKeyName') ? parDatabricks.cmkKeyName : ''
    parCmkKeyVersion: contains(parDatabricks, 'cmkKeyVersion') ? parDatabricks.cmkKeyVersion : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    databricksResourceGroup
  ]
}

// Deploy Azure Data Factory
module datafactoryResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory)) {
  name: 'rg-${basename}-adf-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-adf-${parLocationShort}'
    parTags: tagsDefault
  }
}

module dataFactory 'modules/datafactory/datafactory.bicep' = if (contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory)) {
  name: 'dataFactory'
  scope: resourceGroup('rg-${basename}-adf-${parLocationShort}')
  params: {
    factoryName: contains(parDataFactory, 'factoryName') ? parDataFactory.factoryName : '${basename}-adf'
    location: location
    tags: tagsDefault
    managedVirtualNetworkEnabled: contains(parDataFactory, 'managedVirtualNetworkEnabled') ? parDataFactory.managedVirtualNetworkEnabled : true
    privateEndpointSubnets: contains(parDataFactory, 'privateEndpointSubnets') ? parDataFactory.privateEndpointSubnets : []
    privateDnsZoneIdDataFactory: contains(parDataFactory, 'privateDnsZoneIdDataFactory') ? parDataFactory.privateDnsZoneIdDataFactory : ''
    privateDnsZoneIdPortal: contains(parDataFactory, 'privateDnsZoneIdPortal') ? parDataFactory.privateDnsZoneIdPortal : ''
    parEnableCmk: contains(parDataFactory, 'enableCmk') ? parDataFactory.enableCmk : false
    parCmkKeyVaultUri: contains(parDataFactory, 'cmkKeyVaultUri') ? parDataFactory.cmkKeyVaultUri : ''
    parCmkKeyName: contains(parDataFactory, 'cmkKeyName') ? parDataFactory.cmkKeyName : ''
    parCmkKeyVersion: contains(parDataFactory, 'cmkKeyVersion') ? parDataFactory.cmkKeyVersion : ''
    parCmkIdentityId: contains(parDataFactory, 'cmkIdentityId') ? parDataFactory.cmkIdentityId : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    datafactoryResourceGroup
  ]
}

// Deploy Event Hubs
module eventhubsResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'eventHubs') && bool(deployModules.eventHubs)) {
  name: 'rg-${basename}-eventhubs-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-eventhubs-${parLocationShort}'
    parTags: tagsDefault
  }
}

module eventHubs 'modules/eventhubs/eventhubs.bicep' = if (contains(deployModules, 'eventHubs') && bool(deployModules.eventHubs)) {
  name: 'eventHubs'
  scope: resourceGroup('rg-${basename}-eventhubs-${parLocationShort}')
  params: {
    namespaceName: contains(parEventHubs, 'namespaceName') ? parEventHubs.namespaceName : '${basename}-ehns'
    location: location
    tags: tagsDefault
    sku: contains(parEventHubs, 'sku') ? parEventHubs.sku : 'Standard'
    eventHubs: contains(parEventHubs, 'eventHubs') ? parEventHubs.eventHubs : []
    privateEndpointSubnets: contains(parEventHubs, 'privateEndpointSubnets') ? parEventHubs.privateEndpointSubnets : []
    privateDnsZoneId: contains(parEventHubs, 'privateDnsZoneId') ? parEventHubs.privateDnsZoneId : ''
    parEnableCmk: contains(parEventHubs, 'enableCmk') ? parEventHubs.enableCmk : false
    parCmkKeyVaultUri: contains(parEventHubs, 'cmkKeyVaultUri') ? parEventHubs.cmkKeyVaultUri : ''
    parCmkKeyName: contains(parEventHubs, 'cmkKeyName') ? parEventHubs.cmkKeyName : ''
    parCmkKeyVersion: contains(parEventHubs, 'cmkKeyVersion') ? parEventHubs.cmkKeyVersion : ''
    parCmkIdentityId: contains(parEventHubs, 'cmkIdentityId') ? parEventHubs.cmkIdentityId : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    eventhubsResourceGroup
  ]
}

// Deploy Azure Data Explorer (Kusto)
module dataExplorerResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'dataExplorer') && bool(deployModules.dataExplorer)) {
  name: 'rg-${basename}-adx-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-adx-${parLocationShort}'
    parTags: tagsDefault
  }
}

module dataExplorer 'modules/dataexplorer/dataexplorer.bicep' = if (contains(deployModules, 'dataExplorer') && bool(deployModules.dataExplorer)) {
  name: 'dataExplorer'
  scope: resourceGroup('rg-${basename}-adx-${parLocationShort}')
  params: {
    clusterName: contains(parDataExplorer, 'clusterName') ? parDataExplorer.clusterName : '${basename}adx'
    location: location
    tags: tagsDefault
    skuName: contains(parDataExplorer, 'skuName') ? parDataExplorer.skuName : 'Dev(No SLA)_Standard_E2a_v4'
    skuCapacity: contains(parDataExplorer, 'skuCapacity') ? parDataExplorer.skuCapacity : 1
    databases: contains(parDataExplorer, 'databases') ? parDataExplorer.databases : []
    privateEndpointSubnets: contains(parDataExplorer, 'privateEndpointSubnets') ? parDataExplorer.privateEndpointSubnets : []
    privateDnsZoneId: contains(parDataExplorer, 'privateDnsZoneId') ? parDataExplorer.privateDnsZoneId : ''
    parEnableCmk: contains(parDataExplorer, 'enableCmk') ? parDataExplorer.enableCmk : false
    parCmkKeyVaultUri: contains(parDataExplorer, 'cmkKeyVaultUri') ? parDataExplorer.cmkKeyVaultUri : ''
    parCmkKeyName: contains(parDataExplorer, 'cmkKeyName') ? parDataExplorer.cmkKeyName : ''
    parCmkKeyVersion: contains(parDataExplorer, 'cmkKeyVersion') ? parDataExplorer.cmkKeyVersion : ''
    parCmkIdentityId: contains(parDataExplorer, 'cmkIdentityId') ? parDataExplorer.cmkIdentityId : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    dataExplorerResourceGroup
  ]
}

// Deploy Azure Machine Learning
module mlResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'machineLearning') && bool(deployModules.machineLearning)) {
  name: 'rg-${basename}-ml-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-ml-${parLocationShort}'
    parTags: tagsDefault
  }
}

module machineLearning 'modules/machinelearning/machinelearning.bicep' = if (contains(deployModules, 'machineLearning') && bool(deployModules.machineLearning)) {
  name: 'machineLearning'
  scope: resourceGroup('rg-${basename}-ml-${parLocationShort}')
  params: {
    workspaceName: contains(parMachineLearning, 'workspaceName') ? parMachineLearning.workspaceName : '${basename}-ml'
    location: location
    tags: tagsDefault
    storageAccountId: contains(parMachineLearning, 'storageAccountId') ? parMachineLearning.storageAccountId : ''
    keyVaultId: contains(parMachineLearning, 'keyVaultId') ? parMachineLearning.keyVaultId : ''
    applicationInsightsId: contains(parMachineLearning, 'applicationInsightsId') ? parMachineLearning.applicationInsightsId : ''
    privateEndpointSubnets: contains(parMachineLearning, 'privateEndpointSubnets') ? parMachineLearning.privateEndpointSubnets : []
    parEnableCmk: contains(parMachineLearning, 'enableCmk') ? parMachineLearning.enableCmk : false
    parCmkKeyVaultId: contains(parMachineLearning, 'cmkKeyVaultId') ? parMachineLearning.cmkKeyVaultId : ''
    parCmkKeyIdentifier: contains(parMachineLearning, 'cmkKeyIdentifier') ? parMachineLearning.cmkKeyIdentifier : ''
    parCmkIdentityId: contains(parMachineLearning, 'cmkIdentityId') ? parMachineLearning.cmkIdentityId : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    mlResourceGroup
  ]
}

// Deploy Application Insights
module appInsightsResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'appInsights') && bool(deployModules.appInsights)) {
  name: 'rg-${basename}-monitoring-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-monitoring-${parLocationShort}'
    parTags: tagsDefault
  }
}

module appInsights 'modules/monitoring/appinsights.bicep' = if (contains(deployModules, 'appInsights') && bool(deployModules.appInsights)) {
  name: 'appInsights'
  scope: resourceGroup('rg-${basename}-monitoring-${parLocationShort}')
  params: {
    appInsightsName: contains(parAppInsights, 'appInsightsName') ? parAppInsights.appInsightsName : '${basename}-appi'
    location: location
    tags: tagsDefault
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    applicationType: contains(parAppInsights, 'applicationType') ? parAppInsights.applicationType : 'web'
    disableLocalAuth: contains(parAppInsights, 'disableLocalAuth') ? parAppInsights.disableLocalAuth : true
  }
  dependsOn: [
    appInsightsResourceGroup
  ]
}

// Deploy Azure Functions
module functionsResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'functions') && bool(deployModules.functions)) {
  name: 'rg-${basename}-functions-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-functions-${parLocationShort}'
    parTags: tagsDefault
  }
}

module functions 'modules/functions/functions.bicep' = if (contains(deployModules, 'functions') && bool(deployModules.functions)) {
  name: 'functions'
  scope: resourceGroup('rg-${basename}-functions-${parLocationShort}')
  params: {
    functionAppName: contains(parFunctions, 'functionAppName') ? parFunctions.functionAppName : '${basename}-func'
    location: location
    tags: tagsDefault
    runtime: contains(parFunctions, 'runtime') ? parFunctions.runtime : 'python'
    runtimeVersion: contains(parFunctions, 'runtimeVersion') ? parFunctions.runtimeVersion : '3.11'
    planSku: contains(parFunctions, 'planSku') ? parFunctions.planSku : 'EP1'
    storageAccountId: contains(parFunctions, 'storageAccountId') ? parFunctions.storageAccountId : (contains(deployModules, 'storageZones') && bool(deployModules.storageZones) ? storageServices.outputs.storageRawId : '')
    storageAccountName: contains(parFunctions, 'storageAccountName') ? parFunctions.storageAccountName : ''
    applicationInsightsId: contains(parFunctions, 'applicationInsightsId') ? parFunctions.applicationInsightsId : (contains(deployModules, 'appInsights') && bool(deployModules.appInsights) ? appInsights.outputs.appInsightsId : '')
    applicationInsightsConnectionString: contains(parFunctions, 'applicationInsightsConnectionString') ? parFunctions.applicationInsightsConnectionString : ''
    enableVnetIntegration: contains(parFunctions, 'enableVnetIntegration') ? parFunctions.enableVnetIntegration : false
    vnetIntegrationSubnetId: contains(parFunctions, 'vnetIntegrationSubnetId') ? parFunctions.vnetIntegrationSubnetId : ''
    privateEndpointSubnets: contains(parFunctions, 'privateEndpointSubnets') ? parFunctions.privateEndpointSubnets : []
    privateDnsZoneId: contains(parFunctions, 'privateDnsZoneId') ? parFunctions.privateDnsZoneId : ''
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    enableResourceLock: contains(parFunctions, 'enableResourceLock') ? parFunctions.enableResourceLock : true
  }
  dependsOn: [
    functionsResourceGroup
  ]
}

// Deploy Stream Analytics
module streamAnalyticsResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'streamAnalytics') && bool(deployModules.streamAnalytics)) {
  name: 'rg-${basename}-asa-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-asa-${parLocationShort}'
    parTags: tagsDefault
  }
}

module streamAnalytics 'modules/streamanalytics/streamanalytics.bicep' = if (contains(deployModules, 'streamAnalytics') && bool(deployModules.streamAnalytics)) {
  name: 'streamAnalytics'
  scope: resourceGroup('rg-${basename}-asa-${parLocationShort}')
  params: {
    jobName: contains(parStreamAnalytics, 'jobName') ? parStreamAnalytics.jobName : '${basename}-asa'
    location: location
    tags: tagsDefault
    sku: contains(parStreamAnalytics, 'sku') ? parStreamAnalytics.sku : 'Standard'
    streamingUnits: contains(parStreamAnalytics, 'streamingUnits') ? parStreamAnalytics.streamingUnits : 3
    compatibilityLevel: contains(parStreamAnalytics, 'compatibilityLevel') ? parStreamAnalytics.compatibilityLevel : '1.2'
    contentStoragePolicy: contains(parStreamAnalytics, 'contentStoragePolicy') ? parStreamAnalytics.contentStoragePolicy : 'SystemAccount'
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
  }
  dependsOn: [
    streamAnalyticsResourceGroup
  ]
}

// Deploy Generic Storage Account (separate from lake zones)
module genericStorageResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'genericStorage') && bool(deployModules.genericStorage)) {
  name: 'rg-${basename}-genericstorage-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-genericstorage-${parLocationShort}'
    parTags: tagsDefault
  }
}

module genericStorage 'modules/storage/storage.bicep' = if (contains(deployModules, 'genericStorage') && bool(deployModules.genericStorage)) {
  name: 'genericStorage'
  scope: resourceGroup('rg-${basename}-genericstorage-${parLocationShort}')
  params: {
    location: location
    tags: tagsDefault
    storageName: contains(parGenericStorage, 'storageName') ? parGenericStorage.storageName : '${basename}gen'
    privateEndpointSubnets: contains(parGenericStorage, 'privateEndpointSubnets') ? parGenericStorage.privateEndpointSubnets : []
    privateDNSZones: privateDNSZones
    fileSystemNames: contains(parGenericStorage, 'fileSystemNames') ? parGenericStorage.fileSystemNames : []
    storageSku: contains(parGenericStorage, 'storageSku') ? parGenericStorage.storageSku : ''
    enableResourceLock: contains(parGenericStorage, 'enableResourceLock') ? parGenericStorage.enableResourceLock : true
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId
    parEnableCmk: contains(parGenericStorage, 'enableCmk') ? parGenericStorage.enableCmk : false
    parCmkKeyVaultUri: contains(parGenericStorage, 'cmkKeyVaultUri') ? parGenericStorage.cmkKeyVaultUri : ''
    parCmkKeyName: contains(parGenericStorage, 'cmkKeyName') ? parGenericStorage.cmkKeyName : ''
    parCmkKeyVersion: contains(parGenericStorage, 'cmkKeyVersion') ? parGenericStorage.cmkKeyVersion : ''
    parCmkIdentityId: contains(parGenericStorage, 'cmkIdentityId') ? parGenericStorage.cmkIdentityId : ''
  }
  dependsOn: [
    genericStorageResourceGroup
  ]
}

// Deploy Private Endpoints (demonstration: wire for generic storage blob)
module privateEndpoints 'modules/network/privatelink.bicep' = if (contains(deployModules, 'privateEndpoints') && bool(deployModules.privateEndpoints) && contains(deployModules, 'genericStorage') && bool(deployModules.genericStorage)) {
  name: 'privateEndpoints'
  scope: resourceGroup('rg-${basename}-genericstorage-${parLocationShort}')
  params: {
    serviceId: genericStorage.outputs.storageId
    serviceSubResource: contains(parPrivateEndpoints, 'serviceSubResource') ? parPrivateEndpoints.serviceSubResource : 'blob'
    tags: tagsDefault
    privateEndpointSubnets: contains(parPrivateEndpoints, 'privateEndpointSubnets') ? parPrivateEndpoints.privateEndpointSubnets : []
    privateDNSZones: privateDNSZones
    serviceName: contains(parPrivateEndpoints, 'serviceName') ? parPrivateEndpoints.serviceName : '${basename}-gen-pe'
  }
  dependsOn: [
    genericStorage
  ]
}

// Deploy Self-Hosted Integration Runtime (VMSS for ADF)
// Set deployModules.selfHostedIR = true in params to activate.
module shirResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (contains(deployModules, 'selfHostedIR') && bool(deployModules.selfHostedIR)) {
  name: 'rg-${basename}-shir-${parLocationShort}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${basename}-shir-${parLocationShort}'
    parTags: tagsDefault
  }
}

module selfHostedIR 'modules/vms/selfHostedIntegrationRuntime.bicep' = if (contains(deployModules, 'selfHostedIR') && bool(deployModules.selfHostedIR)) {
  name: 'selfHostedIR'
  scope: resourceGroup('rg-${basename}-shir-${parLocationShort}')
  params: {
    location: location
    tags: tagsDefault
    subnetId: contains(parSelfHostedIR, 'subnetId') ? parSelfHostedIR.subnetId : ''
    vmssName: contains(parSelfHostedIR, 'vmssName') ? parSelfHostedIR.vmssName : '${basename}-shir'
    vmssSkuName: contains(parSelfHostedIR, 'vmssSkuName') ? parSelfHostedIR.vmssSkuName : 'Standard_DS2_v2'
    vmssSkuTier: contains(parSelfHostedIR, 'vmssSkuTier') ? parSelfHostedIR.vmssSkuTier : 'Standard'
    vmssSkuCapacity: contains(parSelfHostedIR, 'vmssSkuCapacity') ? parSelfHostedIR.vmssSkuCapacity : 1
    administratorUsername: contains(parSelfHostedIR, 'administratorUsername') ? parSelfHostedIR.administratorUsername : 'VmssMainUser'
    administratorPassword: shirAdminPassword != '' ? shirAdminPassword : (contains(parSelfHostedIR, 'administratorPassword') ? parSelfHostedIR.administratorPassword : '')
    datafactoryIntegrationRuntimeAuthKey: shirAuthKey != '' ? shirAuthKey : (contains(parSelfHostedIR, 'datafactoryIntegrationRuntimeAuthKey') ? parSelfHostedIR.datafactoryIntegrationRuntimeAuthKey : '')
  }
  dependsOn: [
    shirResourceGroup
  ]
}

/***************************************************************************************************************************************************
RBAC Role Assignments — Service-to-Service Identity Wiring
Assigns managed identities the required roles on dependent services.
Built-in Role Definition IDs reference: https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
***************************************************************************************************************************************************/

// ADF → Storage: Storage Blob Data Contributor (ba92f5b4-2d11-453d-a403-e96b0029c9fe)
module roleAdfToStorage '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory) && contains(deployModules, 'storageZones') && bool(deployModules.storageZones)) {
  name: 'rbac-adf-storage-blob-contributor'
  scope: resourceGroup('rg-${basename}-storage-${parLocationShort}')
  params: {
    principalId: dataFactory.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    roleDescription: 'ADF managed identity → Storage Blob Data Contributor on lake storage'
  }
  dependsOn: [
    dataFactory
    storageServices
  ]
}

// ADF → External Storage: Storage Blob Data Contributor
module roleAdfToExternalStorage '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory) && contains(deployModules, 'externalStorage') && bool(deployModules.externalStorage)) {
  name: 'rbac-adf-ext-storage-blob-contributor'
  scope: resourceGroup('rg-${basename}-externalstorage-${parLocationShort}')
  params: {
    principalId: dataFactory.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    roleDescription: 'ADF managed identity → Storage Blob Data Contributor on external storage'
  }
  dependsOn: [
    dataFactory
    externalStorageServices
  ]
}

// Synapse → Storage: Storage Blob Data Contributor
module roleSynapseToStorage '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'synapse') && bool(deployModules.synapse) && contains(deployModules, 'storageZones') && bool(deployModules.storageZones)) {
  name: 'rbac-synapse-storage-blob-contributor'
  scope: resourceGroup('rg-${basename}-storage-${parLocationShort}')
  params: {
    principalId: synapseWorkspace.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    roleDescription: 'Synapse managed identity → Storage Blob Data Contributor on lake storage'
  }
  dependsOn: [
    synapseWorkspace
    storageServices
  ]
}

// Databricks → Storage: Storage Blob Data Contributor
module roleDatabricksToStorage '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'databricks') && bool(deployModules.databricks) && contains(deployModules, 'storageZones') && bool(deployModules.storageZones)) {
  name: 'rbac-databricks-storage-blob-contributor'
  scope: resourceGroup('rg-${basename}-storage-${parLocationShort}')
  params: {
    principalId: databricksWorkspace.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    roleDescription: 'Databricks managed identity → Storage Blob Data Contributor on lake storage'
  }
  dependsOn: [
    databricksWorkspace
    storageServices
  ]
}

// Data Explorer → Storage: Storage Blob Data Reader (2a2b9908-6ea1-4ae2-8e65-a410df84e7d1)
module roleAdxToStorage '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'dataExplorer') && bool(deployModules.dataExplorer) && contains(deployModules, 'storageZones') && bool(deployModules.storageZones)) {
  name: 'rbac-adx-storage-blob-reader'
  scope: resourceGroup('rg-${basename}-storage-${parLocationShort}')
  params: {
    principalId: dataExplorer.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    roleDescription: 'Data Explorer managed identity → Storage Blob Data Reader on lake storage'
  }
  dependsOn: [
    dataExplorer
    storageServices
  ]
}

// ADF → Event Hubs: Azure Event Hubs Data Sender (2b629674-e913-4c01-ae53-ef4638d8f975)
module roleAdfToEventHubs '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory) && contains(deployModules, 'eventHubs') && bool(deployModules.eventHubs)) {
  name: 'rbac-adf-eventhubs-data-sender'
  scope: resourceGroup('rg-${basename}-eventhubs-${parLocationShort}')
  params: {
    principalId: dataFactory.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2b629674-e913-4c01-ae53-ef4638d8f975')
    roleDescription: 'ADF managed identity → Event Hubs Data Sender'
  }
  dependsOn: [
    dataFactory
    eventHubs
  ]
}

// Data Explorer → Event Hubs: Azure Event Hubs Data Receiver (a638d3c7-ab3a-418d-83e6-5f17a39d4fde)
module roleAdxToEventHubs '../shared/modules/roleAssignment.bicep' = if (contains(deployModules, 'dataExplorer') && bool(deployModules.dataExplorer) && contains(deployModules, 'eventHubs') && bool(deployModules.eventHubs)) {
  name: 'rbac-adx-eventhubs-data-receiver'
  scope: resourceGroup('rg-${basename}-eventhubs-${parLocationShort}')
  params: {
    principalId: dataExplorer.outputs.managedIdentityPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
    roleDescription: 'Data Explorer managed identity → Event Hubs Data Receiver'
  }
  dependsOn: [
    dataExplorer
    eventHubs
  ]
}

// Outputs — Service Resource IDs
output cosmosDbAccountId string = contains(deployModules, 'cosmosDB') && bool(deployModules.cosmosDB) ? cosmosdb.outputs.cosmosDbAccountId : ''
output storageAccountId string = contains(deployModules, 'storageZones') && bool(deployModules.storageZones) ? storageServices.outputs.storageRawId : ''
output synapseWorkspaceId string = contains(deployModules, 'synapse') && bool(deployModules.synapse) ? synapseWorkspace.outputs.synapseId : ''
output synapseManagedIdentityPrincipalId string = contains(deployModules, 'synapse') && bool(deployModules.synapse) ? synapseWorkspace.outputs.managedIdentityPrincipalId : ''
output databricksWorkspaceId string = contains(deployModules, 'databricks') && bool(deployModules.databricks) ? databricksWorkspace.outputs.workspaceId : ''
output databricksWorkspaceUrl string = contains(deployModules, 'databricks') && bool(deployModules.databricks) ? databricksWorkspace.outputs.workspaceUrl : ''
output databricksManagedIdentityPrincipalId string = contains(deployModules, 'databricks') && bool(deployModules.databricks) ? databricksWorkspace.outputs.managedIdentityPrincipalId : ''
output dataFactoryId string = contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory) ? dataFactory.outputs.factoryId : ''
output dataFactoryManagedIdentityPrincipalId string = contains(deployModules, 'dataFactory') && bool(deployModules.dataFactory) ? dataFactory.outputs.managedIdentityPrincipalId : ''
output eventHubsNamespaceId string = contains(deployModules, 'eventHubs') && bool(deployModules.eventHubs) ? eventHubs.outputs.namespaceId : ''
output dataExplorerId string = contains(deployModules, 'dataExplorer') && bool(deployModules.dataExplorer) ? dataExplorer.outputs.clusterId : ''
output machineLearningId string = contains(deployModules, 'machineLearning') && bool(deployModules.machineLearning) ? machineLearning.outputs.workspaceId : ''
output appInsightsId string = contains(deployModules, 'appInsights') && bool(deployModules.appInsights) ? appInsights.outputs.appInsightsId : ''
output functionsAppId string = contains(deployModules, 'functions') && bool(deployModules.functions) ? functions.outputs.functionAppId : ''
output functionsManagedIdentityPrincipalId string = contains(deployModules, 'functions') && bool(deployModules.functions) ? functions.outputs.managedIdentityPrincipalId : ''
output streamAnalyticsJobId string = contains(deployModules, 'streamAnalytics') && bool(deployModules.streamAnalytics) ? streamAnalytics.outputs.jobId : ''
output genericStorageId string = contains(deployModules, 'genericStorage') && bool(deployModules.genericStorage) ? genericStorage.outputs.storageId : ''
