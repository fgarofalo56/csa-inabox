// Main Bicep File for setting up the landing zone
targetScope = 'subscription'

// Metadata
metadata name = 'ALZ Bicep - Subscription Policy Assignments'
metadata description = 'Module used to assign policy definitions to management groups'

// General parameters
// Specify the location for all resources.
@allowed([
  'EastUS'
  'East US'
  'EastUS2'
  'East US 2'
  'WestUS'
  'West US'
  'WestUS2'
  'West US 2'
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

@sys.description('Set Parameter to false to skip the addition of a Private DNS Zone for Azure Backup.')
param parPrivateDnsZoneAutoMergeAzureBackupZone bool = true

// Specify the parEnvironment of the deployment.
@allowed([
  'dev'
  'tst'
  'uat'
  'stg'
  'prod'
])
@description('Specify the parEnvironment of the deployment.')
@minLength(2)
param parEnvironment string = 'dev'

// Subscriptions IDs for deployment scopes

@description('Specify the ALZ Subscription ID.')
param parALZ_SubscriptionId string

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
param prefix string = 'alz'

@description('Primary technical contact for deployed resources.')
param primaryContact string = 'platform-team@contoso.com'

@description('Cost center or billing code for deployed resources.')
param costCenter string = 'CSA-Platform'

@description('List of allowed IP addresses for storage firewall rules.')
param parAllowedIpAddresses array = []

@sys.description('Prefix used for the management group hierarchy.')
@minLength(2)
@maxLength(10)
param parTopLevelManagementGroupPrefix string = 'alz'

@sys.description('Parameter to build base name for resources to include prefix and parEnvironment')
@minLength(4)
param name string = toLower('${prefix}-${parEnvironment}')

// Built in Role Assignments Parameter
param roleAssignmentIds array

// Policy Assignment parameters (List of built in Initiatives: https://learn.microsoft.com/en-us/azure/governance/policy/samples/built-in-initiatives)
@sys.description('List of Built In Policy Initiative Names to Assign')
param initiatives array

// Network Parameters
// Hub Vnet Parameters
@sys.description('Array to hold all vaules for hub networking module.')
param hubNetwork object

@sys.description('Parameter used to set the location of the hub network.')
param parHubLocation string = hubNetwork.parLocation

@sys.description('Parameter to build Hub Network Name')
param parHubBaseNetworkName string = hubNetwork.parHubNetworkName
param parHubNetworkName string = '${name}-${parHubBaseNetworkName}-${parHubLocation}'

@sys.description('Parameter to build Hub Resource Group Name')
param parHubResourceGroupName string = 'rg-${name}-hubnetwork-${hubNetwork.parLocation}'

// Spoke Vnet Parameters
@sys.description('Array to hold all vaules for spoke networking module.')
// param spokeNetwork object
param parSpokeNetworks array

param parRouteSpokesToHubFirewall bool

// Private DNS Zones Parameters
@sys.description('Parameter to build Private DNS Zones Resource Group Name')
param parPrivateDnsZonesResourceGroupName string = 'rg-${name}-dns-${parHubLocation}'

// Logging Parameters
param parLoggingResourceGroupName string = 'rg-${name}-logging'
param parLogAnalytics object
param parLogAnalyticsWorkspaceSolutions array = parLogAnalytics.parLogAnalyticsWorkspaceSolutions.value

@sys.description('Set Parameter to true to Opt-out of deployment telemetry.')
param parTelemetryOptOut bool = false

// Customer Usage Attribution Id
var varCuaid = 'b6718c54-b49e-4748-a466-88e3d7c789c8'

// Variables
// Default tags
var tagsDefault = {
  Owner: 'Azure Landing Zone & Cloud Scale Analytics Scenario'
  Project: 'Azure Demo ALZ & CSA'
  environment: parEnvironment
  Toolkit: 'Bicep'
  PrimaryContact: primaryContact
  CostCenter: costCenter
}

// Union of default tags and user-defined tags
var tagsJoined = union(tagsDefault, tags)

// Number of policy assignments
var policyAssignmentCount = length(initiatives)

var varAzBackupGeoCodes = {
  australiacentral: 'acl'
  australiacentral2: 'acl2'
  australiaeast: 'ae'
  australiasoutheast: 'ase'
  brazilsouth: 'brs'
  brazilsoutheast: 'bse'
  centraluseuap: 'ccy'
  canadacentral: 'cnc'
  canadaeast: 'cne'
  centralus: 'cus'
  eastasia: 'ea'
  eastus2euap: 'ecy'
  eastus: 'eus'
  eastus2: 'eus2'
  francecentral: 'frc'
  francesouth: 'frs'
  germanycentral: 'gec'
  germanynorth: 'gn'
  germanynortheast: 'gne'
  germanywestcentral: 'gwc'
  israelcentral: 'ilc'
  italynorth: 'itn'
  centralindia: 'inc'
  southindia: 'ins'
  westindia: 'inw'
  japaneast: 'jpe'
  japanwest: 'jpw'
  jioindiacentral: 'jic'
  jioindiawest: 'jiw'
  koreacentral: 'krc'
  koreasouth: 'krs'
  northcentralus: 'ncus'
  northeurope: 'ne'
  norwayeast: 'nwe'
  norwaywest: 'nww'
  polandcentral: 'plc'
  qatarcentral: 'qac'
  southafricanorth: 'san'
  southafricawest: 'saw'
  southcentralus: 'scus'
  swedencentral: 'sdc'
  swedensouth: 'sds'
  southeastasia: 'sea'
  switzerlandnorth: 'szn'
  switzerlandwest: 'szw'
  uaecentral: 'uac'
  uaenorth: 'uan'
  uksouth: 'uks'
  ukwest: 'ukw'
  westcentralus: 'wcus'
  westeurope: 'we'
  westus: 'wus'
  westus2: 'wus2'
  westus3: 'wus3'
  usdodcentral: 'udc'
  usdodeast: 'ude'
  usgovarizona: 'uga'
  usgoviowa: 'ugi'
  usgovtexas: 'ugt'
  usgovvirginia: 'ugv'
  usnateast: 'exe'
  usnatwest: 'exw'
  usseceast: 'rxe'
  ussecwest: 'rxw'
  chinanorth: 'bjb'
  chinanorth2: 'bjb2'
  chinanorth3: 'bjb3'
  chinaeast: 'sha'
  chinaeast2: 'sha2'
  chinaeast3: 'sha3'
}
// Variables
// Private DNS Zones for Azure Commercial - AzureCloud
var varAzureCloudPrivateDNSZones = [
  'privatelink${environment().suffixes.keyvaultDns}'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.dfs.${environment().suffixes.storage}'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.web.${environment().suffixes.storage}'
  'privatelink${environment().suffixes.sqlServerHostname}'
  'privatelink.${replace(toLower(location),' ','')}.azmk8s.io'
  'privatelink.${replace(toLower(location),' ','')}.kusto.windows.net'
  'privatelink.mysql.database.azure.com'
  'privatelink.mariadb.database.azure.com'
  'privatelink.postgres.database.azure.com'
  'privatelink.dev.azuresynapse.net'
  'privatelink.webpubsub.azure.com'
  'privatelink.openai.azure.com'
  'privatelink.services.ai.azure.com'
  'privatelink.token.botframework.com'
  'privatelink.redisenterprise.cache.azure.net'
  'privatelink.pbidedicated.windows.net'
  'privatelink.prod.migration.windowsazure.com'
  'privatelink.prod.powerquery.microsoft.com'
  'privatelink.kubernetesconfiguration.azure.com'
  'privatelink.media.azure.net'
  'privatelink.digitaltwins.azure.net'
  'privatelink.directline.botframework.com'
  'privatelink.azurehealthcareapis.com'
  'privatelink.azurestaticapps.net'
  'privatelink.azure-api.net'
  'privatelink.analysis.windows.net'
  'privatelink.afs.azure.net'
  'privatelink.sql.azuresynapse.net'
  'privatelink.azuresynapse.net'
  'privatelink.${replace(toLower(location),' ','')}.batch.azure.com'
  'privatelink.mongo.cosmos.azure.com'
  'privatelink.table.cosmos.azure.com'
  'privatelink.gremlin.cosmos.azure.com'
  'privatelink.documents.azure.com'
  'privatelink.adf.azure.com'
  'privatelink.agentsvc.azure-automation.net'
  'privatelink.api.azureml.ms'
  'privatelink.azconfig.io'
  'privatelink.azure-automation.net'
  '${replace(toLower(location),' ','')}.data.privatelink.azurecr.io'
  'privatelink.azurecr.io'
  'privatelink.azure-devices.net'
  'privatelink.azure-devices-provisioning.net'
  'privatelink.azuredatabricks.net'
  'privatelink.azurehdinsight.net'
  'privatelink.azurewebsites.net'
  'scm.privatelink.azurewebsites.net'
  'privatelink.cassandra.cosmos.azure.com'
  'privatelink.cognitiveservices.azure.com'
  'privatelink.datafactory.azure.net'
  'privatelink.dicom.azurehealthcareapis.com'
  'privatelink.fhir.azurehealthcareapis.com'
  'privatelink.workspace.azurehealthcareapis.com'
  'privatelink.eventgrid.azure.net'
  'privatelink.monitor.azure.com'
  'privatelink.notebooks.azure.net'
  'privatelink.ods.opinsights.azure.com'
  'privatelink.oms.opinsights.azure.com'
  'privatelink.purview.azure.com'
  'privatelink.purviewstudio.azure.com'
  'privatelink.redis.cache.windows.net'
  'privatelink.search.windows.net'
  'privatelink.servicebus.windows.net'
  'privatelink.siterecovery.windowsazure.com'
  'privatelink.vaultcore.azure.net'
  'privatelink-global.wvd.microsoft.com'
  'privatelink.wvd.microsoft.com'
]
// Private DNS Zones for Azure US Government zones - AzureUSGovernment
var varAzureUSGovernmentPrivateDNSZone = [
  'privatelink${environment().suffixes.keyvaultDns}'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.dfs.${environment().suffixes.storage}'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.queue.${environment().suffixes.storage}'
  'privatelink.table.${environment().suffixes.storage}'
  'privatelink.web.${environment().suffixes.storage}'
  'privatelink${environment().suffixes.sqlServerHostname}'
  'privatelink.mysql.database.usgovcloudapi.net'
  'privatelink.postgres.database.usgovcloudapi.net'
  'privatelink.adx.monitor.azure.us'
  'privatelink.azuresynapse.usgovcloudapi.net'
  'privatelink.dev.azuresynapse.usgovcloudapi.net'
  'privatelink.batch.usgovcloudapi.net'
  'privatelink.mongo.cosmos.azure.us'
  'privatelink.table.cosmos.azure.us'
  'privatelink.gremlin.cosmos.azure.us'
  'privatelink.documents.azure.us'
  'privatelink.adf.azure.us'
  'privatelink.agentsvc.azure-automation.us'
  'privatelink.api.ml.azure.us'
  'privatelink.azconfig.azure.us'
  'privatelink.azure-automation.us'
  '${replace(toLower(location),' ','')}.privatelink.azurecr.us'
  'privatelink.azurecr.us'
  'privatelink.azure-devices.us'
  'privatelink.azure-devices-provisioning.us'
  'privatelink.databricks.azure.us'
  'privatelink.azurehdinsight.us'
  'privatelink.azurewebsites.us'
  'scm.privatelink.azurewebsites.us'
  'privatelink.cassandra.cosmos.azure.us'
  'privatelink.cognitiveservices.azure.us'
  'privatelink.datafactory.azure.us'
  'privatelink.dicom.azurehealthcareapis.us'
  'privatelink.fhir.azurehealthcareapis.us'
  'privatelink.workspace.azurehealthcareapis.us'
  'privatelink.eventgrid.azure.us'
  'privatelink.monitor.azure.us'
  'privatelink.notebooks.usgovcloudapi.net'
  'privatelink.ods.opinsights.azure.us'
  'privatelink.oms.opinsights.azure.us'
  'privatelink.purview.azure.us'
  'privatelink.purviewstudio.azure.us'
  'privatelink.redis.cache.usgovcloudapi.net'
  'privatelink.search.azure.us'
  'privatelink.servicebus.usgovcloudapi.net'
  'privatelink.siterecovery.windowsazure.us'
  'privatelink.vaultcore.usgovcloudapi.net'
  'privatelink-global.wvd.azure.us'
  'privatelink.wvd.azure.us'
  'privatelink.${replace(toLower(location),' ','')}.backup.windowsazure.us'
]
// Private DNS Zones for Deployment based on the parEnvironment
var varPrivateDNSZones = environment().name == 'AzureCloud'
  ? varAzureCloudPrivateDNSZones
  : (environment().name == 'AzureUSGovernment' ? varAzureUSGovernmentPrivateDNSZone : [])

// Private DNS Zones for Azure Backup        
// If region entered in location and matches a lookup to varAzBackupGeoCodes then insert Azure Backup Private DNS Zone with appropriate geo code inserted alongside zones in varPrivateDNSZones. If not just return varPrivateDNSZones
var varPrivateDnsZonesMerge = parPrivateDnsZoneAutoMergeAzureBackupZone && contains(varAzBackupGeoCodes, location)
  ? union(
      varPrivateDNSZones,
      ['privatelink.${varAzBackupGeoCodes[replace(toLower(location),' ','')]}.backup.windowsazure.com']
    )
  : varPrivateDNSZones

// Private DNS Zones
var varPrivateDnsZoneResource = [
  for i in varPrivateDnsZonesMerge: {
    zone: resourceId(
      hubNetwork.parHubSubscriptionId,
      parPrivateDnsZonesResourceGroupName,
      'Microsoft.Network/privateDnsZones',
      '${i}'
    )
    zoneName: i
  }
]

// // List of Virtual Networks used for Private DNS Zone Links
var varSpokeVirtualNetworks = [
  for spoke in parSpokeNetworks: {
    vnetID: resourceId(
      hubNetwork.parHubSubscriptionId,
      'rg-${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}',
      'Microsoft.Network/virtualNetworks',
      ('${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}')
    )
    vnetName: concat(name, '-', spoke.parSpokeNetworkName, '-', spoke.parLocation)
  }
]

// Combine DNS Zones with Virtual Networks
var varPrivateDnsZoneLinks = [
  for i in varPrivateDnsZoneResource: {
    zone: i.zone
    zoneName: i.zoneName
    vnets: varSpokeVirtualNetworks
  }
]
var varPrivateDNSZoneVnets = [
  for v in range(0, length(varSpokeVirtualNetworks)): map(
    varPrivateDnsZoneLinks,
    (x, i) => { zone: x.zone, zoneName: x.zoneName, vName: x.vnets[v].vnetName, vNetId: x.vnets[v].vnetID }
  )
]

/***************************************************************************************************************************************************
Resource Modules and Deployments
***************************************************************************************************************************************************/

// Logging RG
module loggingResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (bool(deployModules.logging)) {
  name: parLoggingResourceGroupName
  scope: subscription(parALZ_SubscriptionId)
  params: {
    parLocation: location
    parResourceGroupName: parLoggingResourceGroupName
    parTags: tagsJoined
  }
}
// Custom Role Definitions
// Subscription Owner Role
module alzSubscriptionOwnerRole 'modules/customRoleDefinitions/definitions/alzSubscriptionOwnerRole.bicep' = if (bool(deployModules.requirements)) {
  name: 'alzSubscriptionOwnerRole'
  scope: subscription(parALZ_SubscriptionId)
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// Application Owner Role
module alzApplicationOwnerRole 'modules/customRoleDefinitions/definitions/alzApplicationOwnerRole.bicep' = if (bool(deployModules.requirements)) {
  name: 'alzApplicationOwnerRole'
  scope: subscription(parALZ_SubscriptionId)
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// Network Management Role
module alzNetworkManagementRole 'modules/customRoleDefinitions/definitions/alzNetworkManagementRole.bicep' = if (bool(deployModules.requirements)) {
  name: 'alzNetworkManagementRole'
  scope: subscription(parALZ_SubscriptionId)
  params: {
    parAssignableScopeSubscriptionId: parALZ_SubscriptionId
  }
}
// Security Operations Role
module alzSecurityOperationsRole 'modules/customRoleDefinitions/definitions/alzSecurityOperationsRole.bicep' = if (bool(deployModules.requirements)) {
  name: 'alzSecurityManagementRole'
  scope: subscription(parALZ_SubscriptionId)
  params: {
    parAssignableScopeSubscriptionId: parALZ_SubscriptionId
  }
}
// User Assigned Identity
module userAssignedIdentity 'modules/identity/userAssignedIdentity.bicep' = if (bool(deployModules.requirements)) {
  name: 'userAssignedIdentity'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
  params: {
    location: location
    prefix: prefix
    tags: tagsJoined
  }
  dependsOn: [
    loggingResourceGroup
  ]
}
// resource userAssignedIdentityExisting 'Microsoft.ManagedIdentity/userAssignedIdentities@2018-11-30' existing = if (!bool(deployModules.requirements)) {
//   name: '${prefix}-umi-identity'
//   scope: resourceGroup(parLoggingResourceGroupName)
// }

// Automation Account
module resAutomationAccount 'modules/identity/automationAccount.bicep' = if (bool(deployModules.requirements)) {
  name: 'resAutomationAccount'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
  params: {
    location: location
    prefix: prefix
    environment: parEnvironment
    tags: tagsJoined
  }
  dependsOn: [
    loggingResourceGroup
  ]
}
resource resAutomationAccountExisting 'Microsoft.Automation/automationAccounts@2022-08-08' existing = if (!bool(deployModules.requirements)) {
  name: '${prefix}-${parEnvironment}-automation-account'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
}

// Role Assignments
// Custom Role Assignments for alz Subscription Owner Role and User Assigned Identity
module roleAssignmentUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = if (bool(deployModules.requirements)) {
  name: 'roleAssignment-UserAssignedIdentity'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId
  }
  dependsOn: [
    loggingResourceGroup
  ]
}
// Custom Role Assignments for alz Subscription Owner Role and Automation Account
module roleAssignmentAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = if (bool(deployModules.requirements)) {
  name: 'roleAssignment-AutomationAccount'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: resAutomationAccount.outputs.automationAccountPrincipalId
  }
  dependsOn: [
    loggingResourceGroup
  ]
}
// Bulit In Role Assignments for Policies UAI from roleAssignmentIds
module roleAssignmentBuiltInUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = [
  for i in roleAssignmentIds: if (bool(deployModules.requirements)) {
    name: 'roleAssignment-UAI-${i}'
    scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
    params: {
      roleDefinitionId: '/providers/microsoft.authorization/roleDefinitions/${i}'
      principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId
    }
    dependsOn: [
      loggingResourceGroup
    ]
  }
]
// Bulit In Role Assignments for Policies AutomationAccount from roleAssignmentIds
module roleAssignmentBuiltInAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = [
  for i in roleAssignmentIds: if (bool(deployModules.requirements)) {
    name: 'roleAssignment-AA-${i}'
    scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
    params: {
      roleDefinitionId: '/providers/microsoft.authorization/roleDefinitions/${i}'
      principalId: resAutomationAccount.outputs.automationAccountPrincipalId
    }
    dependsOn: [
      loggingResourceGroup
    ]
  }
]

// Defualt Storage Account for Logging and Metrics Data 
module resStorageAccount 'modules/storage/storageAccount.bicep' = if (bool(deployModules.logging)) {
  name: 'resStorageAccount-DefaultstorageAcct-${parLoggingResourceGroupName}'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
  params: {
    parmStorageAccountName: 'logdfttsacct${parLoggingResourceGroupName}${uniqueString(subscription().subscriptionId)}'
    location: location
    prefix: prefix
    environment: parEnvironment
    tags: tagsJoined
    resourceGroup: parLoggingResourceGroupName
    skuName: 'Standard_LRS'
    kind: 'StorageV2'
    accessTier: 'Hot'
    bypassServies: 'AzureServices'
    defaultAction: 'Allow'
    isHnsEnabled: false
    ipRules: [for ip in parAllowedIpAddresses: {
      value: ip
      action: 'Allow'
    }]
  }
  dependsOn: [
    loggingResourceGroup
  ]
}

// Log Analytics Workspace
module logAnalyticsWorkspace 'modules/logging/logging.bicep' = if (bool(deployModules.logging)) {
  name: 'deploy-logAnalyticsWorkspace'
  scope: resourceGroup(parALZ_SubscriptionId, parLoggingResourceGroupName)
  dependsOn: [
    loggingResourceGroup
  ]
  params: {
    parmLogAnalyticsWorkspaceName: '${name}-${parLogAnalytics.parWorkspaceSufix}'
    parLocation: parLogAnalytics.parLocation
    automationAccountID: (bool(deployModules.requirements))
      ? resAutomationAccount.outputs.automationAccountId
      : resAutomationAccountExisting.id
    storageAccountId: resStorageAccount.outputs.storageAccountId
    prefix: prefix
    environment: parEnvironment
    tags: tagsJoined
    parLoggingRG: parLoggingResourceGroupName
    parLogAnalyticsWorkspaceSkuName: parLogAnalytics.parLogAnalyticsWorkspaceSkuName
    parDCRWorkspaceTransformationName: parLogAnalytics.parDCRWorkspaceTransformationName
    parLogAnalyticsWorkspaceLogRetentionInDays: parLogAnalytics.parLogAnalyticsWorkspaceLogRetentionInDays
    parDataCollectionRuleVMInsightsName: parLogAnalytics.parDataCollectionRuleVMInsightsName
    parDataCollectionRuleChangeTrackingName: parLogAnalytics.parDataCollectionRuleChangeTrackingName
    parDataCollectionRuleMDFCSQLName: parLogAnalytics.parDataCollectionRuleMDFCSQLName
    parLogAnalyticsWorkspaceSolutions: parLogAnalyticsWorkspaceSolutions
  }
}

resource resLAWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (!bool(deployModules.logging)) {
  name: '${name}-${parLogAnalytics.parWorkspaceSufix}'
  scope: resourceGroup(parSpokeNetworks[0].parHubSubscriptionId, parLoggingResourceGroupName)
}

// Diagnostic Settings
module diagSettings 'modules/logging/DiagSettings/DiagSetting.bicep' = if (bool(deployModules.logging)) {
  name: 'deploy-diagSettings-config'
  scope: subscription(parALZ_SubscriptionId)
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    loggingResourceGroup
  ]
  params: {
    parLogAnalyticsWorkspaceResourceId: logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
    prefix: prefix
    environment: parEnvironment
  }
}

// Policy Assignments
module policyAssignments 'modules/policy/policy.bicep' = if (bool(deployModules.policy)) {
  name: 'policyAssignments-module-deployment'
  scope: subscription(parALZ_SubscriptionId)
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
  ]
  params: {
    location: location
    prefix: prefix
    environment: parEnvironment
    initiatives: initiatives
    userAssignedIdentity: userAssignedIdentity
    tags: tagsJoined
    parmLogAnalytics: logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
    nonComplianceMessage: 'This resource is not compliant, enable setting for Data Observability, Logging, Diagnostic Settings Azure resources'
    parmLoggingRG: parLoggingResourceGroupName
  }
}

// Remediation Tasks
module remediationTaskModule 'modules/policy/remediation/policyRemediation.bicep' = [
  for i in range(0, policyAssignmentCount): if (bool(deployModules.policy)) {
    name: '${name}-${policyAssignments.name}-remediationTask-${i}'
    scope: subscription(parALZ_SubscriptionId)
    params: {
      policyAssignmentid: policyAssignments.outputs.policySetAssignments[i].policyAssignmentId
      policyAssignmentName: policyAssignments.outputs.policySetAssignments[i].policyAssignmentName
      environment: parEnvironment
    }
    dependsOn: [
      logAnalyticsWorkspace ?? resLAWorkspace
    ]
  }
]

// Networking Resources
module hubResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (bool(deployModules.hubNetwork)) {
  name: 'DeployHubRG-${parHubResourceGroupName}'
  scope: subscription(hubNetwork.parHubSubscriptionId)
  params: {
    parLocation: location
    parResourceGroupName: parHubResourceGroupName
    parTags: tagsJoined
  }
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
  ]
}

// Private DNS Zones RG
module privateDnsZonesResourceGroup 'modules/resourceGroup/resourceGroup.bicep' = if (bool(deployModules.hubNetwork)) {
  name: 'DeployPrivateDNSZoneRG-${parPrivateDnsZonesResourceGroupName}'
  scope: subscription(hubNetwork.parHubSubscriptionId)
  params: {
    parLocation: location
    parResourceGroupName: parPrivateDnsZonesResourceGroupName
    parTags: tagsJoined
  }
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    hubResourceGroup
  ]
}

// Hub Network Module
module hubNetworkdeploy 'modules/networking/hub/hubNetworking.bicep' = if (bool(deployModules.hubNetwork)) {
  name: 'DeployHubNetwork-${parHubNetworkName}'
  scope: resourceGroup(hubNetwork.parHubSubscriptionId, parHubResourceGroupName)
  params: {
    parHubNetworkName: parHubNetworkName
    hubNetwork: hubNetwork
    parPrivateDnsZonesResourceGroup: parPrivateDnsZonesResourceGroupName
    parTags: tagsJoined
  }
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    hubResourceGroup
    privateDnsZonesResourceGroup
  ]
}

/********************************************************************************************************************

Spoke Network Modules
Deploy and configure spoke networks and subnets

*********************************************************************************************************************/

resource resHubVnet 'Microsoft.Network/virtualNetworks@2023-02-01' existing = if (bool(deployModules.hubNetwork) || parSpokeNetworks[0].parHubAlreadyExists) {
  name: parHubNetworkName
  scope: resourceGroup(parSpokeNetworks[0].parHubSubscriptionId, parHubResourceGroupName)
}

resource resAzF 'Microsoft.Network/azureFirewalls@2024-03-01' existing = if (bool(deployModules.hubNetwork) || parSpokeNetworks[0].parHubAlreadyExists) {
  name: hubNetwork.parAzFirewallName.value
  scope: resourceGroup(parSpokeNetworks[0].parHubSubscriptionId, parHubResourceGroupName)
}

module deploySpokeNetworks 'modules/networking/spoke/main.bicep' = if (bool(deployModules.spokeNetwork)) {
  name: 'DeploySpoke-SpokeNetworks'
  scope: subscription()
  params: {
    parLocation: location
    parSpokeNetworks: parSpokeNetworks
    parRouteSpokesToHubFirewall: parRouteSpokesToHubFirewall
    parHubFirewallPrivateIP: resAzF.properties.ipConfigurations[0].properties.privateIPAddress
    parHubVirtualNetworkResourceGroup: parHubResourceGroupName
    parHubVirtualNetworkName: resHubVnet.name
    parResHubVirtualNetworkId: resHubVnet.id
    tags: tagsJoined
  }
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    hubResourceGroup
    hubNetworkdeploy
    privateDnsZonesResourceGroup
    resHubVnet
  ]
}

// // Private DNS Zones
// Module - Private DNS Zone Virtual Network Link to Spoke 1 using varPrivateDnsZoneLinks

module modPrivateDnsZoneLinkToSpoke 'modules/networking/privateDnsZoneLinks/privateDnsZoneLinks.bicep' = [
  for i in varPrivateDNSZoneVnets[0]: if (!empty(varPrivateDNSZoneVnets) && (bool(deployModules.spokeNetwork))) {
    scope: resourceGroup(parSpokeNetworks[0].parHubSubscriptionId, parPrivateDnsZonesResourceGroupName)
    name: take('${i.zoneName}-${i.vName}-${uniqueString(i.zoneName)}', 64)
    params: {
      parPrivateDnsZoneResourceId: i.zone
      parDnsZoneName: i.zoneName // Extracting the DNS zone name from the resource ID
      parSpokeVirtualNetworkResourceId: i.vNetId
      parVNetName: i.vName
    }
    dependsOn: [
      logAnalyticsWorkspace ?? resLAWorkspace
      hubResourceGroup
      hubNetworkdeploy
      privateDnsZonesResourceGroup
    ]
  }
]

// Security Center Deployment and Configuration
module modSecurityCenter 'modules/security/security-center/securityCenter.bicep' = if (bool(deployModules.securityCenter)) {
  name: 'securityCenterDeployment'
  params: {
    scope: '/subscriptions/${subscription().subscriptionId}'
    workspaceResourceId: (bool(deployModules.logging))
      ? logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
      : resLAWorkspace.id
    location: location
    virtualMachinesPricingTier: 'Standard'
    sqlServersPricingTier: 'Standard'
    appServicesPricingTier: 'Standard'
    storageAccountsPricingTier: 'Standard'
    sqlServerVirtualMachinesPricingTier: 'Standard'
    kubernetesServicePricingTier: 'Standard'
    containerRegistryPricingTier: 'Standard'
    keyVaultsPricingTier: 'Standard'
    dnsPricingTier: 'Standard'
    armPricingTier: 'Standard'
    openSourceRelationalDatabasesTier: 'Standard'
    containersTier: 'Standard'
    cosmosDbsTier: 'Standard'
    // ioTSecuritySolutionProperties:
  }
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
  ]
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Resource ID of the Log Analytics workspace.')
output logAnalyticsWorkspaceId string = bool(deployModules.logging)
  ? logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
  : resLAWorkspace.id

@description('Resource ID of the hub virtual network.')
output hubVnetId string = resHubVnet.id

@description('Private IP address of the Azure Firewall in the hub network.')
output firewallPrivateIp string = resAzF.properties.ipConfigurations[0].properties.privateIPAddress
