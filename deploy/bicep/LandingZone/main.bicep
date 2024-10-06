// Main Bicep File for setting up the landing zone
targetScope = 'subscription'

// Metadata
metadata name = 'ALZ Bicep - Subscription Policy Assignments'
metadata description = 'Module used to assign policy definitions to management groups'

// General parameters
// Specify the location for all resources.
@allowed([
  'East US'
  'East US 2'
  'West US 2'
  'West US 3'
  'Central US'
  'South Central US'
  'West Central US'
  'North Central US'
  'East US 2'
  'Central US'
  'South Central US'
  'West US'
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
param prefix string = 'alz'

@sys.description('Prefix used for the management group hierarchy.')
@minLength(2)
@maxLength(10)
param parTopLevelManagementGroupPrefix string = 'alz'

@sys.description('Parameter to build base name for resources to include prefix and environment')
param name string = toLower('${prefix}-${environment}')

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
param parHubResourceGroupName string = concat('rg-${name}-hubnetwork-', hubNetwork.parLocation)

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
  environment: environment
  Toolkit: 'Bicep'
  PrimaryContact: 'frgarofa'
  CostCenter: 'FFL ATU - exp12345'
  }

// Union of default tags and user-defined tags
var tagsJoined = union(tagsDefault, tags)

// Number of policy assignments
var policyAssignmentCount = length(initiatives)

// Private DNS Zones
var varPrivateDnsZoneResource = [for i in hubNetwork.parPrivateDnsZones.value: {
 zone: resourceId(subscription().subscriptionId,parPrivateDnsZonesResourceGroupName, 'Microsoft.Network/privateDnsZones', '${i}')
 zoneName: i
}]


// // List of Virtual Networks used for Private DNS Zone Links
var varSpokeVirtualNetworks = [for spoke in parSpokeNetworks: {
  vnetID: resourceId(subscription().subscriptionId, 'rg-${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}', 'Microsoft.Network/virtualNetworks', ('${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}'))
  vnetName: concat(name,'-',spoke.parSpokeNetworkName,'-',spoke.parLocation)
}]

// Combine DNS Zones with Virtual Networks
var varPrivateDnsZoneLinks = [
  for i in varPrivateDnsZoneResource: {
    zone: i.zone
    zoneName: i.zoneName
    vnets: varSpokeVirtualNetworks
  }
]
var varPrivateDNSZoneVnets = [for v in range(0, length(varSpokeVirtualNetworks)): map(varPrivateDnsZoneLinks, (x, i) => 
    {zone: x.zone 
    zoneName: x.zoneName 
    vName: x.vnets[v].vnetName 
    vNetId: x.vnets[v].vnetID}
  ) 
]



/***************************************************************************************************************************************************
Resource Modules and Deployments
***************************************************************************************************************************************************/

// Logging RG
module loggingResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.logging) ) {
  name: parLoggingResourceGroupName
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: parLoggingResourceGroupName
    parTags: tagsJoined
  }
}
// Custom Role Definitions
// Subscription Owner Role
module alzSubscriptionOwnerRole 'modules/customRoleDefinitions/definitions/alzSubscriptionOwnerRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzSubscriptionOwnerRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// Application Owner Role
module alzApplicationOwnerRole 'modules/customRoleDefinitions/definitions/alzApplicationOwnerRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzApplicationOwnerRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// Network Management Role
module alzNetworkManagementRole 'modules/customRoleDefinitions/definitions/alzNetworkManagementRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzNetworkManagementRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// Security Operations Role
module alzSecurityOperationsRole 'modules/customRoleDefinitions/definitions/alzSecurityOperationsRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzSecurityManagementRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// User Assigned Identity
module userAssignedIdentity 'modules/identity/userAssignedIdentity.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'userAssignedIdentity'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
        location: location
        prefix: prefix
        tags: tagsJoined        
  }
  dependsOn: [
    loggingResourceGroup
  ]
}
resource userAssignedIdentityExisting 'Microsoft.ManagedIdentity/userAssignedIdentities@2018-11-30' existing = if (!bool(deployModules.requirments) ){
  name: '${prefix}-umi-identity'
  scope: resourceGroup(parLoggingResourceGroupName)
}

// Automation Account
module resAutomationAccount 'modules/identity/automationAccount.bicep' =  if ( bool(deployModules.requirments) ){
  name: 'resAutomationAccount'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
    location: location
    prefix: prefix
    environment: environment
    tags: tagsJoined
    
 }
 dependsOn: [
    loggingResourceGroup
  ]
}
resource resAutomationAccountExisting 'Microsoft.Automation/automationAccounts@2022-08-08' existing = if (!bool(deployModules.requirments) ){
  name: '${prefix}-${environment}-automation-account'
  scope: resourceGroup(parLoggingResourceGroupName)
}

// Role Assignments
// Custom Role Assignments for alz Subscription Owner Role and User Assigned Identity
module roleAssignmentUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'roleAssignment-UserAssignedIdentity'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId    
  }
  dependsOn: [
    userAssignedIdentity
    loggingResourceGroup
  ]
}
// Custom Role Assignments for alz Subscription Owner Role and Automation Account
module roleAssignmentAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' =  if ( bool(deployModules.requirments) ){
  name: 'roleAssignment-AutomationAccount'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: resAutomationAccount.outputs.automationAccountPrincipalId    
  }
  dependsOn: [
    resAutomationAccount
    loggingResourceGroup
  ]
}
// Bulit In Role Assignments for Policies UAI from roleAssignmentIds
module roleAssignmentBuiltInUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' =  [ for i in roleAssignmentIds : if ( bool(deployModules.requirments) ) {
  name: 'roleAssignment-UAI-${i}'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
    roleDefinitionId: '/providers/microsoft.authorization/roleDefinitions/${i}'
    principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId    
  }
  dependsOn: [
    userAssignedIdentity
    loggingResourceGroup
  ]
}
]
// Bulit In Role Assignments for Policies AutomationAccount from roleAssignmentIds
module roleAssignmentBuiltInAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' =  [ for i in roleAssignmentIds : if ( bool(deployModules.requirments) ) {
  name: 'roleAssignment-AA-${i}'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
    roleDefinitionId: '/providers/microsoft.authorization/roleDefinitions/${i}'
    principalId: resAutomationAccount.outputs.automationAccountPrincipalId    
  }
  dependsOn: [
    resAutomationAccount
    loggingResourceGroup
  ]
}
]

// Defualt Storage Account for Logging and Metrics Data 
module resStorageAccount 'modules/storage/storageAccount.bicep' = if ( bool(deployModules.logging) ) {
  name: 'resStorageAccount-DefaultstorageAcct-${parLoggingResourceGroupName}'
  scope: resourceGroup(parLoggingResourceGroupName)
  params: {
    parmStorageAccountName: 'logdefaultstorageacct${parLoggingResourceGroupName}'
    location: location
    prefix: prefix
    environment: environment
    tags: tagsJoined
    resourceGroup: parLoggingResourceGroupName
    skuName: 'Standard_LRS'
    kind: 'StorageV2'
    accessTier: 'Hot'
    bypassServies: 'AzureServices'
    defaultAction: 'Allow'
    isHnsEnabled: false
    ipRules: [
       {
          value: '98.204.179.172'
          action: 'Allow'
        }
    ]    
}
  dependsOn: [
    loggingResourceGroup
  ]
}

// Log Analytics Workspace
module logAnalyticsWorkspace 'modules/logging/logging.bicep' = if ( bool(deployModules.logging) ) {
  name: 'deploy-logAnalyticsWorkspace'
  scope: resourceGroup(parLoggingResourceGroupName)
  dependsOn: [
    loggingResourceGroup
  ]
  params: {
    parmLogAnalyticsWorkspaceName: '${name}-${parLogAnalytics.parWorkspaceSufix}'
    location: parLogAnalytics.parLocation
    automationAccountID: (bool(deployModules.requirments)) ? resAutomationAccount.outputs.automationAccountId : resAutomationAccountExisting.id
    storageAccountId: resStorageAccount.outputs.storageAccountId
    prefix: prefix
    environment: environment
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

resource resLAWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (!bool(deployModules.logging) ){
  name: '${name}-${parLogAnalytics.parWorkspaceSufix}'
  scope: resourceGroup(parLoggingResourceGroupName)
}


// Diagnostic Settings
module diagSettings 'modules/logging/DiagSettings/DiagSetting.bicep' = if ( bool(deployModules.logging) ) {
  name: 'deploy-diagSettings-config'
  scope: subscription()
      dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    loggingResourceGroup
    ]
  params: {
    parLogAnalyticsWorkspaceResourceId: logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
    prefix: prefix
    environment: environment
  }
}

// Policy Assignments
module policyAssignments 'modules/policy/policy.bicep' = if ( bool(deployModules.policy) ) {
  name: 'policyAssignments-module-deployment'
  scope: subscription()
    dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    userAssignedIdentity
    ]
  params: {
    location: location
    prefix: prefix
    environment: environment
    initiatives: initiatives
    userAssignedIdentity: userAssignedIdentity
    tags: tagsJoined
    parmLogAnalytics: logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
    nonComplianceMessage: 'This resource is not compliant, enable setting for Data Observability, Logging, Diagnostic Settings Azure resources'
    parmLoggingRG: parLoggingResourceGroupName
    
  }
}

// Remediation Tasks
module remediationTaskModule 'modules/policy/remediation/policyRemediation.bicep' = [for i in range(0, policyAssignmentCount): if ( bool(deployModules.policy) ) {
  name: '${name}-${policyAssignments.name}-remediationTask-${i}'
  scope: subscription()
  params: {
    policyAssignmentid: policyAssignments.outputs.policySetAssignments[i].policyAssignmentId
    policyAssignmentName: policyAssignments.outputs.policySetAssignments[i].policyAssignmentName
    environment: environment
  }
  dependsOn: [
    logAnalyticsWorkspace ?? resLAWorkspace
    policyAssignments
    userAssignedIdentity
    ]
  }
]

// Networking Resources
module hubResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.hubNetwork) ) {
  name: 'DeployHubRG-${parHubResourceGroupName}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: parHubResourceGroupName
    
    parTags: tagsJoined
  }
  dependsOn: [    
    logAnalyticsWorkspace ?? resLAWorkspace
    policyAssignments
    remediationTaskModule
  ]
}

// Private DNS Zones RG
module privateDnsZonesResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.hubNetwork) ) {
  name: 'DeployPrivateDNSZoneRG-${parPrivateDnsZonesResourceGroupName}'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: parPrivateDnsZonesResourceGroupName
    parTags: tagsJoined    
  }
  dependsOn: [  
    logAnalyticsWorkspace ?? resLAWorkspace
    policyAssignments
    remediationTaskModule
  ]
}

// Hub Network Module
module hubNetworkdeploy 'modules/networking/hub/hubNetworking.bicep' = if ( bool(deployModules.hubNetwork) ) {
  name: 'DeployHubNetwork-${parHubNetworkName}'
  scope: resourceGroup(parHubResourceGroupName)
  params: {
    parHubNetworkName: parHubNetworkName     
    hubNetwork: hubNetwork
    parPrivateDnsZonesResourceGroup: parPrivateDnsZonesResourceGroupName
    parTags: tagsJoined    
  }
  dependsOn: [
  ]
}

/********************************************************************************************************************

Spoke Network Modules
Deploy and configure spoke networks and subnets

*********************************************************************************************************************/

resource resHubVnet 'Microsoft.Network/virtualNetworks@2023-02-01' existing = {
  name: parHubNetworkName
  scope: resourceGroup(parHubResourceGroupName)
}

resource resAzF 'Microsoft.Network/azureFirewalls@2023-02-01' existing = {
name: hubNetwork.parAzFirewallName.value
scope: resourceGroup(parHubResourceGroupName)
}


module deploySokeNetworks 'modules/networking/spoke/main.bicep' = if ( bool(deployModules.spokeNetwork) ) {
  name: 'DeploySpoke-SpokeNetworks'
  scope: subscription()
  params: {
    location: location
    parSpokeNetworks: parSpokeNetworks
    parRouteSpokesToHubFirewall: parRouteSpokesToHubFirewall    
    parHubFirewallPrivateIP: '${resAzF.properties.ipConfigurations[0].properties.privateIPAddress}'
    parHubVirtualNetworkResourceGroup: parHubResourceGroupName
    parHubVirtualNetworkName: '${resHubVnet.name}'
    parResHubVirtualNetworkId: '${resHubVnet.id}'
    tags: tagsJoined
  }
  dependsOn: [
    resHubVnet
    resAzF
  ]
}

// // Private DNS Zones
// Module - Private DNS Zone Virtual Network Link to Spoke 1 using varPrivateDnsZoneLinks

module modPrivateDnsZoneLinkToSpoke 'modules/networking/privateDnsZoneLinks/privateDnsZoneLinks.bicep' = [for i in varPrivateDNSZoneVnets[0]: if (!empty(varPrivateDNSZoneVnets) && (bool(deployModules.spokeNetwork))) {
  scope: resourceGroup(parPrivateDnsZonesResourceGroupName)
  name: take('${i.zoneName}-${i.vName}-${uniqueString(i.zoneName)}', 64)
  params: {
    parPrivateDnsZoneResourceId: i.zone
    parDnsZoneName: i.zoneName // Extracting the DNS zone name from the resource ID
    parSpokeVirtualNetworkResourceId: i.vNetId
    parVNetName: i.vName
  }
  dependsOn: [
    hubNetworkdeploy
    privateDnsZonesResourceGroup
    deploySokeNetworks
  ]
}]

// Security Center Deployment and Configuration
module modSecurityCenter 'modules/security/security-center/securityCenter.bicep' = if ( bool(deployModules.securityCenter) ) {
  name: 'securityCenterDeployment'
  params: {
    scope: '/subscriptions/${subscription().subscriptionId}'
    workspaceResourceId: (bool(deployModules.logging)) ? logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId: resLAWorkspace.id
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
