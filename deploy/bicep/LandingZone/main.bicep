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

// Generic Parameters - Used in multiple modules

@sys.description('Prefix used for the management group hierarchy.')
@minLength(2)
@maxLength(10)
param parTopLevelManagementGroupPrefix string = 'alz'

// @sys.description('Optional suffix for the management group hierarchy. This suffix will be appended to management group names/IDs. Include a preceding dash if required. Example: -suffix')
// @maxLength(10)
// param parTopLevelManagementGroupSuffix string = ''

// @sys.description('Subscription Id to the Virtual Network Hub object. Default: Empty String')
// param parPeeredVnetSubscriptionId string = ''

// @sys.description('Set Parameter to true to Opt-out of deployment telemetry.')
// param parTelemetryOptOut bool = false

@sys.description('''Global Resource Lock Configuration used for all resources deployed in this module.

- `kind` - The lock settings of the service which can be CanNotDelete, ReadOnly, or None.
- `notes` - Notes about this lock.

''')

// Subscription Module Parameters
@sys.description('The Management Group Id to place the subscription in. Default: Empty String')
param parPeeredVnetSubscriptionMgPlacement string = ''


// Built in Role Assignments Parameter
param roleAssignmentIds array

// Policy Assignment parameters (List of built in Initiatives: https://learn.microsoft.com/en-us/azure/governance/policy/samples/built-in-initiatives)
@sys.description('List of Built In Policy Initiative Names to Assign')
param initiatives array

// Network parameters
@sys.description('Array to hold all vaules for hub networking module.')
param hubNetwork object

@sys.description('Array to hold all vaules for spoke networking module.')
param spokeNetwork object


// Variables
var name = toLower('${prefix}-${environment}')
var tagsDefault = {
  Owner: 'Azure Landing Zone & Cloud Scale Analytics Scenario'
  Project: 'Azure Demo ALZ & CSA'
  environment: environment
  Toolkit: 'Bicep'
  PrimaryContact: 'frgarofa'
  CostCenter: 'FFL ATU - exp12345'
  }
var tagsJoined = union(tagsDefault, tags)
// var varSubscription = subscription()



// Logging RG
module loggingResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.logging) ) {
  name: 'rg-${name}-logging'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${name}-logging'
    // parResourceLockConfig: null
    parTelemetryOptOut: false
    parTags: tagsJoined
  }
}

// Custom Role Definitions
module alzSubscriptionOwnerRole 'modules/customRoleDefinitions/definitions/alzSubscriptionOwnerRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzSubscriptionOwnerRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}

module alzApplicationOwnerRole 'modules/customRoleDefinitions/definitions/alzApplicationOwnerRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzApplicationOwnerRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}

module alzNetworkManagementRole 'modules/customRoleDefinitions/definitions/alzNetworkManagementRole.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'alzNetworkManagementRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}

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
  scope: resourceGroup(loggingResourceGroup.name)
  params: {
        location: location
        prefix: prefix
        tags: tagsJoined
  }
}

// Automation Account
module resAutomationAccount 'modules/identity/automationAccount.bicep' =  if ( bool(deployModules.requirments) ){
  name: 'resAutomationAccount'
  scope: resourceGroup(loggingResourceGroup.name)
  params: {
    location: location
    prefix: prefix
    environment: environment
    tags: tagsJoined
 }
}

// Role Assignments
module roleAssignmentUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = if ( bool(deployModules.requirments) ) {
  name: 'roleAssignment-UserAssignedIdentity'
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId
  }
}

module roleAssignmentAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' =  if ( bool(deployModules.requirments) ){
  name: 'roleAssignment-AutomationAccount'
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: resAutomationAccount.outputs.automationAccountPrincipalId
  }
}

// Bulit In Role Assignments for Policies UAI
module roleAssignmentBuiltInUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' =  [ for i in roleAssignmentIds : if ( bool(deployModules.requirments) ) {
  name: 'roleAssignment-UAI-${i}'
  params: {
    roleDefinitionId: '/providers/microsoft.authorization/roleDefinitions/${i}'
    principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId
  }
}
]
// Bulit In Role Assignments for Policies AutomationAccount
module roleAssignmentBuiltInAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' =  [ for i in roleAssignmentIds : if ( bool(deployModules.requirments) ) {
  name: 'roleAssignment-AA-${i}'
  params: {
    roleDefinitionId: '/providers/microsoft.authorization/roleDefinitions/${i}'
    principalId: resAutomationAccount.outputs.automationAccountPrincipalId
  }
}
]

// Defualt Storage Account for Logging and Metrics Data 
module resStorageAccount 'modules/storage/storageAccount.bicep' = if ( bool(deployModules.logging) ) {
  name: 'resStorageAccount'
  scope: resourceGroup(loggingResourceGroup.name)
  params: {
    location: location
    prefix: prefix
    environment: environment
    tags: tagsJoined
    resourceGroup: loggingResourceGroup.name
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
}

// Log Analytics Workspace
module logAnalyticsWorkspace 'modules/logging/logging.bicep' = if ( bool(deployModules.logging) ) {
  name: 'logAnalyticsWorkspace'
  scope: resourceGroup(loggingResourceGroup.name)
  dependsOn: [
    loggingResourceGroup
  ]
  params: {
    location: location
    automationAccountID: resAutomationAccount.outputs.automationAccountId
    storageAccountId: resStorageAccount.outputs.storageAccountId
    prefix: prefix
    environment: environment
    tags: tagsJoined   
    parLoggingRG: loggingResourceGroup.outputs.outResourceGroupName 
  }
}


// Diagnostic Settings
module diagSettings 'modules/logging/DiagSettings/DiagSetting.bicep' = if ( bool(deployModules.logging) ) {
  name: 'diagSettings'
  scope: subscription()
      dependsOn: [
    logAnalyticsWorkspace
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
  name: 'policyAssignments'
  scope: subscription()
    dependsOn: [
    logAnalyticsWorkspace
    diagSettings
    userAssignedIdentity
    loggingResourceGroup
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
    parmLoggingRG: loggingResourceGroup.name
  }
}


// Remediation Tasks
var policyAssignmentCount = length(initiatives)
module remediationTaskModule 'modules/policy/remediation/policyRemediation.bicep' = [for i in range(0, policyAssignmentCount): if ( bool(deployModules.policy) ) {
  name: '${prefix}-${policyAssignments.name}-remediationTask-${i}'
  scope: subscription()
  dependsOn: [
    logAnalyticsWorkspace
    diagSettings
    policyAssignments
    userAssignedIdentity
    ]
  params: {
    policyAssignmentid: policyAssignments.outputs.policySetAssignments[i].policyAssignmentId
    policyAssignmentName: policyAssignments.outputs.policySetAssignments[i].policyAssignmentName
    // prefix: '${prefix}'
    environment: environment
  }
}
]

// // Networking Resources
// Hub RG 
module hubResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.hubNetwork) ) {
  name: 'DeployHubRG'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${name}-hubnetwork-${hubNetwork.parLocation}'
    // parResourceLockConfig: null
    parTags: tagsJoined
  }
}

// Private DNS Zones RG
module privateDnsZonesResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.hubNetwork) ) {
  name: 'DeployPrivateDNSZoneRG'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${name}-dns-${hubNetwork.parLocation}'
    // parResourceLockConfig: null
    parTags: tagsJoined
  }
}

// Hub Network Module
module hubNetworkdeploy 'modules/networking/hub/hubNetworking.bicep' = if ( bool(deployModules.hubNetwork) ) {
  name: take('${prefix}-hubnetwork-${environment}-${hubNetwork.parLocation}', 100)
  scope: resourceGroup('rg-${name}-hubnetwork-${hubNetwork.parLocation}')
  params: {
    parHubNetworkName: '${prefix}-hubnetwork-${environment}-${hubNetwork.parLocation}'      
    hubNetwork: hubNetwork
    parPrivateDnsZonesResourceGroup: privateDnsZonesResourceGroup.outputs.outResourceGroupName
    parTags: tagsJoined
  }
}


/********************************************************************************************************************

Spoke Network Module
Below is the code for the spoke network module

*********************************************************************************************************************/

// Spoke RG Module - Resource Group
module modSpokeResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.spokeNetwork) ) {
  name: 'DeploySpokeRG'
  scope: subscription()
  params: {
    parLocation: location
    parResourceGroupName: 'rg-${name}-${spokeNetwork.parSpokeNetworkName}-${spokeNetwork.parLocation}'
    // parResourceLockConfig: null
    parTags: tagsJoined
  }
}

module modSpokeNetworking 'modules/networking/spoke/spokeNetworking.bicep' = if ( bool(deployModules.spokeNetwork) )  {
  scope: resourceGroup('rg-${name}-${spokeNetwork.parSpokeNetworkName}-${spokeNetwork.parLocation}')
  name: 'deploySpokeNetworking-${spokeNetwork.parSpokeNetworkName}-${uniqueString(subscription().subscriptionId, spokeNetwork.parSpokeNetworkName)}'
  dependsOn: [
    modSpokeResourceGroup
  ]
  params: {
    spokeNetwork: spokeNetwork
    parSpokeNetworkName:  '${prefix}-${spokeNetwork.parSpokeNetworkName}-${environment}-${hubNetwork.parLocation}'
    // parTags: tagsJoined
    parTags:  union(tagsJoined, spokeNetwork.parTags.value)
  }
}


// Private DNS Zones
// , 
var varPrivateDnsZoneResourceIds = [for i in hubNetwork.parPrivateDnsZones.value: {
 zone: resourceId('Microsoft.Network/privateDnsZones', '${i}')
 zoneName: i
}]

// Module - Private DNS Zone Virtual Network Link to Spoke
module modPrivateDnsZoneLinkToSpoke 'modules/networking/privateDnsZoneLinks/privateDnsZoneLinks.bicep' = [for i in varPrivateDnsZoneResourceIds: if (!empty(varPrivateDnsZoneResourceIds)) {
  scope: resourceGroup('rg-${name}-dns-${hubNetwork.parLocation}')
  name: take('${split(i.zoneName,'.')[1]}-${uniqueString(i.zone)}', 64)
  params: {
    parPrivateDnsZoneResourceId: i.zone
    parSpokeVirtualNetworkResourceId: modSpokeNetworking.outputs.outSpokeVirtualNetworkId
    parResourceLockConfig: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.?notes : spokeNetwork.parPrivateDnsZoneVirtualNetworkLinkLock.value.?notes
  }
}]

// // Module - Hub to Spoke peering.
// module modHubPeeringToSpoke '../../modules/vnetPeering/vnetPeering.bicep' = if (!empty(varHubVirtualNetworkName)) {
//   scope: resourceGroup(varHubVirtualNetworkSubscriptionId, varHubVirtualNetworkResourceGroup)
//   name: varModuleDeploymentNames.modSpokePeeringFromHub
//   params: {
//     parDestinationVirtualNetworkId: (!empty(varHubVirtualNetworkName) ? modSpokeNetworking.outputs.outSpokeVirtualNetworkId : '')
//     parDestinationVirtualNetworkName: (!empty(varHubVirtualNetworkName) ? modSpokeNetworking.outputs.outSpokeVirtualNetworkName : '')
//     parSourceVirtualNetworkName: varHubVirtualNetworkName
//     parAllowForwardedTraffic: parAllowSpokeForwardedTraffic
//     parAllowGatewayTransit: parAllowHubVpnGatewayTransit
//     parTelemetryOptOut: parTelemetryOptOut
//   }
// }

// // Module - Spoke to Hub peering.
// module modSpokePeeringToHub '../../modules/vnetPeering/vnetPeering.bicep' = if (!empty(varHubVirtualNetworkName)) {
//   scope: resourceGroup(parPeeredVnetSubscriptionId, parResourceGroupNameForSpokeNetworking)
//   name: varModuleDeploymentNames.modSpokePeeringToHub
//   params: {
//     parDestinationVirtualNetworkId: parHubVirtualNetworkId
//     parDestinationVirtualNetworkName: varHubVirtualNetworkName
//     parSourceVirtualNetworkName: (!empty(varHubVirtualNetworkName) ? modSpokeNetworking.outputs.outSpokeVirtualNetworkName : '')
//     parUseRemoteGateways: parAllowHubVpnGatewayTransit
//     parTelemetryOptOut: parTelemetryOptOut
//   }
// }

// // Module -  Spoke to Azure Virtual WAN Hub peering.
// module modhubVirtualNetworkConnection '../../modules/vnetPeeringVwan/hubVirtualNetworkConnection.bicep' = if (!empty(varVirtualHubResourceId)) {
//   scope: resourceGroup(varVirtualHubSubscriptionId, varVirtualHubResourceGroup)
//   name: varModuleDeploymentNames.modVnetPeeringVwan
//   params: {
//     parVirtualWanHubResourceId: varVirtualHubResourceId
//     parRemoteVirtualNetworkResourceId: modSpokeNetworking.outputs.outSpokeVirtualNetworkId
//     parVirtualHubConnectionPrefix: parVirtualHubConnectionPrefix
//     parVirtualHubConnectionSuffix: parVirtualHubConnectionSuffix
//     parEnableInternetSecurity: parEnableInternetSecurity
//   }
// }

// output outSpokeVirtualNetworkName string = modSpokeNetworking.outputs.outSpokeVirtualNetworkName
// output outSpokeVirtualNetworkId string = modSpokeNetworking.outputs.outSpokeVirtualNetworkId
