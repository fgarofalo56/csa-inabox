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
param spokeNetworks array

// @sys.description('Parameter used to set the location of the spoke network.')
// param parSpokeLocation string = spokeNetwork.parLocation

// @sys.description('Parameter to build Spoke Network Name')
// param parSpokeBaseNetworkName string = spokeNetwork.parSpokeNetworkName
// param parSpokeNetworkName string = '${name}-${parSpokeBaseNetworkName}-${parSpokeLocation}'

// @sys.description('Parameter to build Spoke Resource Group Name')
// param parSpokeResourceGroupName string = 'rg-${parSpokeNetworkName}'

// // Spoke2 Vnet Parameters
// @sys.description('Array to hold all vaules for spoke networking module.')
// param spokeNetwork2 object

// @sys.description('Parameter used to set the location of the spoke network.')
// param parSpoke2Location string = spokeNetwork2.parLocation

// @sys.description('Parameter to build Spoke Network Name')
// param parSpoke2BaseNetworkName string = spokeNetwork2.parSpokeNetworkName
// param parSpoke2NetworkName string = '${name}-${parSpoke2BaseNetworkName}-${parSpoke2Location}'

// @sys.description('Parameter to build Spoke Resource Group Name')
// param parSpoke2ResourceGroupName string = 'rg-${parSpoke2NetworkName}'

// Private DNS Zones Parameters
@sys.description('Parameter to build Private DNS Zones Resource Group Name')
param parPrivateDnsZonesResourceGroupName string = 'rg-${name}-dns-${parHubLocation}'

// Logging Parameters
param parLoggingResourceGroupName string = 'rg-${name}-logging'

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
 zone: resourceId('Microsoft.Network/privateDnsZones', '${i}')
 zoneName: i
}]


// List of Virtual Networks used for Private DNS Zone Links
var varSpokeVirtualNetworks = [for spoke in spokeNetworks: {
  vnetID: resourceId('Microsoft.Network/virtualNetworks', ('${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}'))
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
    parmLogAnalyticsWorkspaceName: '${name}-dataObservability-logAnalyticsWorkspace'
    location: location
    automationAccountID: resAutomationAccount.outputs.automationAccountId
    storageAccountId: resStorageAccount.outputs.storageAccountId
    prefix: prefix
    environment: environment
    tags: tagsJoined   
    parLoggingRG: parLoggingResourceGroupName    
  }
}

// Diagnostic Settings
module diagSettings 'modules/logging/DiagSettings/DiagSetting.bicep' = if ( bool(deployModules.logging) ) {
  name: 'deploy-diagSettings-config'
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
  name: 'policyAssignments-module-deployment'
  scope: subscription()
    dependsOn: [
    loggingResourceGroup  
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
    loggingResourceGroup
    logAnalyticsWorkspace
    diagSettings
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
    loggingResourceGroup
    logAnalyticsWorkspace
    diagSettings
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
    loggingResourceGroup
    logAnalyticsWorkspace
    diagSettings
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
    hubResourceGroup
    privateDnsZonesResourceGroup
  ]
}

/********************************************************************************************************************

Spoke Network Modules
Deploy and configure spoke networks and subnets

*********************************************************************************************************************/
// Spoke 1

module modSpokeResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  [for i in spokeNetworks: if ( bool(deployModules.spokeNetwork) ) {
  // name: 'DeploySpokeRG-${parSpokeResourceGroupName}'
  name: 'DeploySpokeRG-rg-${name}-${i.parSpokeNetworkName}-${i.parLocation}'
  scope: subscription()
  params: {
    // parLocation: 
    parLocation: i.parLocation
    // parResourceGroupName: parSpokeResourceGroupName
    parResourceGroupName: 'rg-${name}-${i.parSpokeNetworkName}-${i.parLocation}'
    // parTags: tagsJoined
    parTags: i.parTags.value    
  }
  dependsOn: [
    loggingResourceGroup
    logAnalyticsWorkspace
    diagSettings
    policyAssignments
    remediationTaskModule
    hubResourceGroup
    hubNetworkdeploy
  ]
}
]

//Deploy Spoke Network vNets:

module modSpokeNetworking 'modules/networking/spoke/spokeNetworking.bicep' = [for vnet in spokeNetworks: if ( bool(deployModules.spokeNetwork) )  {
  scope: resourceGroup('rg-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}')
  // name: 'deploySpokeNetworking-${parSpokeNetworkName}-${uniqueString(subscription().subscriptionId, parSpokeNetworkName)}'
  name: 'deploySpokeNetwork-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}'
  params: {
    // spokeNetwork: spokeNetwork    
    // parSpokeNetworkName: parSpokeNetworkName
    parSpokeNetworkName: '${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}'
    parSpokeLocation: vnet.parLocation
    parTags: union(tagsJoined, vnet.parTags.value)    
    parSpokeNetworkAddressPrefix: vnet.parSpokeNetworkAddressPrefix
    parSpokeNetworkarDdosProtectionPlanId: vnet.pspokeNetworkarDdosProtectionPlanId
    parDnsServerIps: vnet.parDnsServerIps
    parSpokeNetworkLock: vnet.parSpokeNetworkLock
    parGlobalResourceLock: vnet.parGlobalResourceLock
    parSpokeToHubRouteTableName: vnet.parSpokeToHubRouteTableName
    parNextHopIpAddress: vnet.parNextHopIpAddress
    parDisableBgpRoutePropagation: vnet.parDisableBgpRoutePropagation
    parSpokeRouteTableLock: vnet.parSpokeRouteTableLock
    
  }
    dependsOn: [
    modSpokeResourceGroup
    loggingResourceGroup
    hubResourceGroup
    hubNetworkdeploy
    diagSettings
    policyAssignments
    remediationTaskModule
  ]
}
]

// // Deploy Spoke Subnets (old)
// module modSpokeSubnets 'modules/networking/subnet/subnet.bicep' = [for i in spokeNetworks.parSubnets: if (bool(deployModules.spokeNetwork)) {
//   scope: resourceGroup(parSpokeResourceGroupName)
//   name: concat('deploySpokeSubnets-',parSpokeNetworkName, '-', i.parSubnetName)
//   params: {
//     virtualNetworkName: parSpokeNetworkName
//     name: i.parSubnetName
//     addressPrefix: i.ipAddressRange
//     privateEndpointNetworkPolicies: i.privateEndpointNetworkPolicy
//     routeTableResourceId: modSpokeNetworking.outputs.outSpokeVirtualNetworkRouteTableId
//   }
//   dependsOn: [
//     hubResourceGroup
//     hubNetworkdeploy
//     modSpokeNetworking
//     loggingResourceGroup
//   ]
// }
// ]

// Deploy Spoke Subnets

// module modSpokeSubnets 'modules/networking/subnet/subnet.bicep' = [for (subnet, i) in items(spokeNetworks.value.parSubnets): if (bool(deployModules.spokeNetwork)) {
//   scope: resourceGroup('rg-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}')
//   // name: concat('deploySpokeSubnets-',parSpokeNetworkName, '-', i.parSubnetName)
//   name: concat('deploySpokeSubnets-','${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}-', vnet.parSubnets[i].parSubnetName)
//   params: {
//     virtualNetworkName: '${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}'
//     name: vnet.parSubnets[i].parSubnetName
//     addressPrefix: vnet.parSubnets[i].ipAddressRange
//     privateEndpointNetworkPolicies: vnet.parSubnets[i].privateEndpointNetworkPolicy
//     routeTableResourceId: modSpokeNetworking.outputs.outSpokeVirtualNetworkRouteTableId
//   }
//   dependsOn: [
//     hubResourceGroup
//     hubNetworkdeploy
//     modSpokeNetworking
//     loggingResourceGroup
//   ]
// }
// ]


// // Spoke 2
// module modSpoke2ResourceGroup 'modules/resourceGroup/resourceGroup.bicep' =  if ( bool(deployModules.spokeNetwork2) ) {
//   name: 'DeploySpoke2RG-${parSpoke2ResourceGroupName}'
//   scope: subscription()
//   params: {
//     parLocation: spokeNetwork2.parLocation
//     parResourceGroupName: parSpoke2ResourceGroupName
//     parTags: tagsJoined    
//   }
//   dependsOn: [
//     loggingResourceGroup
//     logAnalyticsWorkspace
//     diagSettings
//     policyAssignments
//     remediationTaskModule
//     hubResourceGroup
//     hubNetworkdeploy
//   ]
// }

// //Build Spoke Network Name:
// module modSpoke2Networking 'modules/networking/spoke/spokeNetworking.bicep' = if ( bool(deployModules.spokeNetwork2) )  {
//   scope: resourceGroup(parSpoke2ResourceGroupName)
//   name: 'deploySpoke2Networking-${parSpoke2NetworkName}-${uniqueString(subscription().subscriptionId, parSpoke2NetworkName)}'
//   params: {
//     spokeNetwork: spokeNetwork2
//     parSpokeNetworkName: parSpoke2NetworkName
//     parTags:  union(tagsJoined, spokeNetwork2.parTags.value)    
//   }
//     dependsOn: [
//     modSpoke2ResourceGroup
//     loggingResourceGroup
//     hubResourceGroup
//     hubNetworkdeploy
//     diagSettings
//     policyAssignments
//     remediationTaskModule
//   ]
// }

// // Deploy Spoke Subnets
// module modSpoke2Subnets 'modules/networking/subnet/subnet.bicep' = [for i in spokeNetwork2.parSubnets: if (bool(deployModules.spokeNetwork2)) {
//   scope: resourceGroup(parSpoke2ResourceGroupName)
//   name: concat('deploySpokeSubnets-',parSpoke2NetworkName, '-', i.parSubnetName)
//   params: {
//     virtualNetworkName: parSpoke2NetworkName
//     name: i.parSubnetName
//     addressPrefix: i.ipAddressRange
//     privateEndpointNetworkPolicies: i.privateEndpointNetworkPolicy
//     routeTableResourceId: modSpoke2Networking.outputs.outSpokeVirtualNetworkRouteTableId
//   }
//   dependsOn: [
//     hubResourceGroup
//     hubNetworkdeploy
//     modSpoke2Networking
//     loggingResourceGroup
//   ]
// }
// ]


// Private DNS Zones
// Module - Private DNS Zone Virtual Network Link to Spoke 1 using varPrivateDnsZoneLinks

module modPrivateDnsZoneLinkToSpoke 'modules/networking/privateDnsZoneLinks/privateDnsZoneLinks.bicep' = [for i in varPrivateDNSZoneVnets[0]: if (!empty(varPrivateDNSZoneVnets) && (bool(deployModules.spokeNetwork))) {
  scope: resourceGroup(parPrivateDnsZonesResourceGroupName)
  name: take('${split(i.zoneName, '.')[1]}-${i.vName}-${uniqueString(i.zoneName)}', 64)
  params: {
    parPrivateDnsZoneResourceId: i.zone
    parDnsZoneName: split(i.zoneName, '/')[8] // Extracting the DNS zone name from the resource ID
    parSpokeVirtualNetworkResourceId: i.vNetId
    parVNetName: i.vName
  }
  dependsOn: [
    modSpokeNetworking
    hubNetworkdeploy
    privateDnsZonesResourceGroup
  ]
}]


// // Module - Private DNS Zone Virtual Network Link to Spoke 2
// module modPrivateDnsZoneLinkToSpoke2 'modules/networking/privateDnsZoneLinks/privateDnsZoneLinks.bicep' = [for i in varPrivateDnsZoneResourceIds: if (!empty(varPrivateDnsZoneResourceIds) && (bool(deployModules.spokeNetwork2 )) ) {
//   scope: resourceGroup(parPrivateDnsZonesResourceGroupName)
//   name: take('${split(i.zoneName,'.')[1]}-${parSpoke2NetworkName}-${uniqueString(i.zone)}', 64)
//   params: {
//     parPrivateDnsZoneResourceId: i.zone
//     parDnsZoneName: i.zoneName
//     parVNetName: parSpoke2NetworkName
//     parSpokeVirtualNetworkResourceId: resourceId(subscription().subscriptionId, parSpoke2ResourceGroupName,'Microsoft.Network/virtualNetworks', parSpoke2NetworkName)    
//   }
//   dependsOn: [
//     modSpoke2Networking
//     hubNetworkdeploy
//     privateDnsZonesResourceGroup
//   ]
// }
// ]

// // Module - Hub to Spoke 2 peering.
// module modHubPeeringToSpoke 'modules/networking/vnetPeering/vnetPeering.bicep' = if (bool(deployModules.spokeNetwork)) {
//   scope: resourceGroup(parHubResourceGroupName)
//   name: take('hubPeerToSpoke-${parHubNetworkName}-${parSpokeNetworkName}-${uniqueString(subscription().subscriptionId, parHubNetworkName)}',64)
//   params: {
//     parDestinationVirtualNetworkId: resourceId(subscription().subscriptionId, parSpokeResourceGroupName,'Microsoft.Network/virtualNetworks', parSpokeNetworkName)
//     parDestinationVirtualNetworkName: parSpokeNetworkName
//     parSourceVirtualNetworkName: parHubNetworkName
//     parAllowForwardedTraffic: spokeNetwork.parAllowSpokeForwardedTraffic
//     parAllowGatewayTransit: spokeNetwork.parAllowHubVpnGatewayTransit
//     parUseRemoteGateways: false
//     parAllowVirtualNetworkAccess: true    
//   }
//   dependsOn: [
//     modSpokeNetworking
//     hubNetworkdeploy
//     privateDnsZonesResourceGroup
//   ]
// }

// // Module - Hub to Spoke 2 peering.
// module modHubPeeringToSpoke2 'modules/networking/vnetPeering/vnetPeering.bicep' = if (bool(deployModules.spokeNetwork2)) {
//   scope: resourceGroup(parHubResourceGroupName)
//   name: take('hubPeerToSpoke-${parHubNetworkName}-${parSpoke2NetworkName}-${uniqueString(subscription().subscriptionId, parHubNetworkName)}',64)
//   params: {
//     parDestinationVirtualNetworkId: resourceId(subscription().subscriptionId, parSpoke2ResourceGroupName,'Microsoft.Network/virtualNetworks', parSpoke2NetworkName)
//     parDestinationVirtualNetworkName: parSpoke2NetworkName
//     parSourceVirtualNetworkName: parHubNetworkName
//     parAllowForwardedTraffic: spokeNetwork2.parAllowSpokeForwardedTraffic
//     parAllowGatewayTransit: spokeNetwork2.parAllowHubVpnGatewayTransit
//     parUseRemoteGateways: false
//     parAllowVirtualNetworkAccess: true    
//   }
//   dependsOn: [
//     modSpoke2Networking
//     hubNetworkdeploy
//     privateDnsZonesResourceGroup
//   ]
// }

// // Module - Spoke 1 to Hub peering.
module modSpokePeeringToHub 'modules/networking/vnetPeering/vnetPeering.bicep' = [for vnet in spokeNetworks: if (bool(deployModules.spokeNetwork)) {
  scope: resourceGroup('rg-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}')
  name: take('spokePeerToHub-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}-${parHubNetworkName}-${uniqueString(subscription().subscriptionId,'${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}')}',64)
  params: {
    parDestinationVirtualNetworkId: resourceId(subscription().subscriptionId, parHubResourceGroupName,'Microsoft.Network/virtualNetworks', parHubNetworkName)
    parDestinationVirtualNetworkName: parHubNetworkName 
    parSourceVirtualNetworkName: '${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}' 
    parUseRemoteGateways: true
    parAllowVirtualNetworkAccess: true
    parAllowForwardedTraffic: true
    parAllowGatewayTransit: false    
  }
  dependsOn: [
    modSpokeNetworking
    hubNetworkdeploy
    privateDnsZonesResourceGroup
  ]
}

]
// // // Module - Spoke 2 to Hub peering.
// module modSpoke2PeeringToHub 'modules/networking/vnetPeering/vnetPeering.bicep' = if (bool(deployModules.spokeNetwork2)) {
//   scope: resourceGroup(parSpoke2ResourceGroupName)
//   name: take('spokePeerToHub-${parSpoke2NetworkName}-${parHubNetworkName}-${uniqueString(subscription().subscriptionId,parSpoke2NetworkName)}',64)
//   params: {
//     parDestinationVirtualNetworkId: resourceId(subscription().subscriptionId, parHubResourceGroupName,'Microsoft.Network/virtualNetworks', parHubNetworkName)
//     parDestinationVirtualNetworkName: parHubNetworkName
//     parSourceVirtualNetworkName: parSpoke2NetworkName 
//     parUseRemoteGateways: true
//     parAllowVirtualNetworkAccess: true
//     parAllowForwardedTraffic: true
//     parAllowGatewayTransit: false    
//   }
//   dependsOn: [
//     modSpoke2Networking
//     hubNetworkdeploy
//     privateDnsZonesResourceGroup
//   ]
// }
