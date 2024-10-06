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

@sys.description('Parameter to build base name for resources to include prefix and environment')
param name string = toLower('${prefix}-${environment}')

// Spoke Vnet Parameters
@sys.description('Array to hold all vaules for spoke networking module.')
// param spokeNetwork object
param parSpokeNetworks array

//Hub Network Parameters
@sys.description('Parameter used to set the location of the hub network.')
param parHubLocation string = 'East US'

@sys.description('Parameter to build Hub Network Name')
param parHubNetworkName string = 'alz-dev-hubVnet-eastus'

@sys.description('Parameter to build Hub Resource Group Name')
param parHubResourceGroupName string = 'rg-alz-dev-hubnetwork-eastus'


// Existing resource names
@sys.description('Name of the resource group where the hub network is deployed.')
param parHubVirtualNetworkResourceGroup string

@sys.description('Name of the hub network.')
param parHubVirtualNetworkName string

@sys.description('Id of the hub network.')
param parResHubVirtualNetworkId string

@sys.description('Name Route Spoke to Hub Firewall.')
param parRouteSpokesToHubFirewall bool

@sys.description('HubFirewall Firewall IP')
param parHubFirewallPrivateIP string


// Define the spoke virtual networks
var varSpokeVirtualNetworks = [for spoke in parSpokeNetworks: {
  vnetName: concat(name,'-',spoke.parSpokeNetworkName,'-',spoke.parLocation)
  pspokeNetworkarDdosProtectionPlanId: spoke.pspokeNetworkarDdosProtectionPlanId
  parDnsServerIps: spoke.parDnsServerIps
  parSpokeNetworkLock: spoke.parSpokeNetworkLock
  parGlobalResourceLock: spoke.parGlobalResourceLock
  parSpokeToHubRouteTableName: spoke.parSpokeToHubRouteTableName
  parNextHopIpAddress: spoke.parNextHopIpAddress
  parDisableBgpRoutePropagation: spoke.parDisableBgpRoutePropagation
  parSpokeRouteTableLock: spoke.parSpokeparRouteTableLock
  vnetLocation: spoke.parLocation
  parTags: spoke.parTags
  vnetNetResourceGroup: 'rg-${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}'
  parSpokeNetworkAddressPrefix: spoke.parSpokeNetworkAddressPrefix
  subnets: map(range(0, length(spoke.parSubnets)), i => {
    name: spoke.parSubnets[i].parSubnetName
    properties: {
      addressPrefix: spoke.parSubnets[i].ipAddressRange
      delegations: (empty(spoke.parSubnets[i].delegation)) ? null : [
        {
          name: spoke.parSubnets[i].delegation
          properties: {
            serviceName: spoke.parSubnets[i].delegation
          }
        }
      ]
      privateEndpointNetworkPolicies: (empty(spoke.parSubnets[i].privateEndpointNetworkPolicy)) ? null : spoke.parSubnets[i].privateEndpointNetworkPolicy
      routeTable: (!bool(spoke.parSubnets[i].parRouteTable)) ? null : {id: resourceId(subscription().subscriptionId, 'rg-${name}-${spoke.parSpokeNetworkName}-${spoke.parLocation}', 'Microsoft.Network/routeTables', spoke.parSpokeToHubRouteTableName)
        properties: {
          disableBgpRoutePropagation: spoke.parSubnets[i].parDisableBgpRoutePropagation
          routes:[
            {
              name: '${spoke.parSubnets[i].parSubnetName}-subnet-to-hubFirewall'
              properties: {
                addressPrefix: spoke.parSubnets[i].ipAddressRange
                nextHopType: 'Virtualappliance'
                nextHopIpAddress: (bool(spoke.parSubnets[i].parRouteTable)) ? parHubFirewallPrivateIP : ''
              }
            }
          ]
        }
      }      
    }
  }
  )
}]


/********************************************************************************************************************
Spoke Network Modules
Deploy and configure spoke networks and subnets
*********************************************************************************************************************/

module modSpokeResourceGroup '../../resourceGroup/resourceGroup.bicep' =  [for i in parSpokeNetworks:  {
  // name: 'DeploySpokeRG-${parSpokeResourceGroupName}'
  name: 'DeploySpokeRG-rg-${name}-${i.parSpokeNetworkName}-${i.parLocation}'
  scope: subscription()
  params: {
    parLocation: i.parLocation
    parResourceGroupName: 'rg-${name}-${i.parSpokeNetworkName}-${i.parLocation}'
    parTags: i.parTags.value    
  }
  dependsOn: [
  ]
}
]

//Deploy Spoke Network vNets:
module modSpokeNetworking '../../networking/spoke/spokeNetworking.bicep' = [for vnet in varSpokeVirtualNetworks:   {
  scope: resourceGroup(vnet.vnetNetResourceGroup)
  name: 'deploySpokeNetwork-${vnet.vnetName}'
  params: {
    parSpokeNetworkName: vnet.vnetName
    parSpokeLocation: vnet.vnetLocation
    parTags: union(tags, vnet.parTags.value)    
    parSpokeNetworkAddressPrefix: vnet.parSpokeNetworkAddressPrefix
    parSpokeNetworkarDdosProtectionPlanId: vnet.pspokeNetworkarDdosProtectionPlanId
    parDnsServerIps: vnet.parDnsServerIps
    parSpokeNetworkLock: vnet.parSpokeNetworkLock
    parGlobalResourceLock: vnet.parGlobalResourceLock
    parSpokeToHubRouteTableName: vnet.parSpokeToHubRouteTableName
    parNextHopIpAddress: vnet.parNextHopIpAddress
    parDisableBgpRoutePropagation: vnet.parDisableBgpRoutePropagation
    parSpokeRouteTableLock: vnet.parSpokeRouteTableLock
    parmSubnetConfigurations: vnet.subnets    
  }
    dependsOn: [
    modSpokeResourceGroup
  ]
}
]

// // Module - Hub to Spokepeering.
module modHubPeeringToSpoke '../..//networking/vnetPeering/vnetPeering.bicep' = [for (vnet, index) in parSpokeNetworks:{
  scope: resourceGroup(parHubVirtualNetworkResourceGroup)
  name: take('HubPeerToSpoke-${parHubVirtualNetworkName}-${uniqueString(subscription().subscriptionId,'${parHubVirtualNetworkResourceGroup}-${index}')}',64)
  params: {
    parDestinationVirtualNetworkId: resourceId(subscription().subscriptionId, 'rg-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}','Microsoft.Network/virtualNetworks',  '${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}')
    parDestinationVirtualNetworkName: '${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}'  
    parSourceVirtualNetworkName: parHubNetworkName 
    parUseRemoteGateways: false
    parAllowVirtualNetworkAccess: true
    parAllowForwardedTraffic: true
    parAllowGatewayTransit: true    
  }
  dependsOn: [
    modSpokeNetworking
  ]
}]

// // Module - Spoke to Hub peering.
module modSpokePeeringToHub '../../networking/vnetPeering/vnetPeering.bicep' = [for (vnet, index) in parSpokeNetworks:{
  scope: resourceGroup('rg-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}')
  name: take('spokePeerToHub-${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}-${parHubNetworkName}-${uniqueString(subscription().subscriptionId,'${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}-${index}')}',64)
  params: {
    parDestinationVirtualNetworkId: parResHubVirtualNetworkId
    parDestinationVirtualNetworkName: parHubVirtualNetworkName 
    parSourceVirtualNetworkName: '${name}-${vnet.parSpokeNetworkName}-${vnet.parLocation}' 
    parUseRemoteGateways: true
    parAllowVirtualNetworkAccess: true
    parAllowForwardedTraffic: true
    parAllowGatewayTransit: false    
  }
  dependsOn: [
    modSpokeNetworking
    modHubPeeringToSpoke
  ]
}
]
