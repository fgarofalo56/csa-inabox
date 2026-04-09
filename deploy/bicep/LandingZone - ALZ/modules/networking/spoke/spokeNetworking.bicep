metadata name = 'ALZ Bicep - Spoke Networking module'
metadata description = 'This module creates spoke networking resources'

type lockType = {
  @description('Optional. Specify the name of lock.')
  name: string?

  @description('Optional. The lock settings of the service.')
  kind: ('CanNotDelete' | 'ReadOnly' | 'None')

  @description('Optional. Notes about this lock.')
  notes: string?
}

// @sys.description('Array to hold all vaules for spoke networking module.')
// param spokeNetwork object

@sys.description('The Name of the Spoke Virtual Network.')
param parSpokeNetworkName string

@sys.description('The Azure Region to deploy the resources into.')
param parSpokeLocation string

@sys.description('Tags you would like to be applied to all resources in this module.')
param parTags object

@sys.description('Address prefix for the Spoke Virtual Network.')
param parSpokeNetworkAddressPrefix string

@sys.description('The DDoS Protection Plan ID to associate with the Spoke Virtual Network.')
param parSpokeNetworkarDdosProtectionPlanId string

@sys.description('The DNS Server IPs to associate with the Spoke Virtual Network.')
param parDnsServerIps object

@sys.description('Virtual Network Lock Configuration.')
param parSpokeNetworkLock object

@sys.description('Global Resource Lock Configuration.')
param parGlobalResourceLock object

@sys.description('The Route Table Name for the Spoke Virtual Network.')
param parSpokeToHubRouteTableName string

@sys.description('Next Hop IP Address for the Spoke Virtual Network Route Table.')
param parNextHopIpAddress string

@sys.description('Disable BGP Route Propagation for the Spoke Virtual Network Route Table.')
param parDisableBgpRoutePropagation bool

@sys.description('Route Table Lock Configuration.')
param parSpokeRouteTableLock object

@description('Array parameter for subnet configurations')
param parmSubnetConfigurations array

//If Ddos parameter is true Ddos will be Enabled on the Virtual Network
//If Azure Firewall is enabled and Network DNS Proxy is enabled DNS will be configured to point to AzureFirewall
resource resSpokeVirtualNetwork 'Microsoft.Network/virtualNetworks@2023-02-01' = {
  name: parSpokeNetworkName
  // location: spokeNetwork.parLocation
  location: parSpokeLocation
  tags: parTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        parSpokeNetworkAddressPrefix
      ]
    }
    enableDdosProtection: (!empty(parSpokeNetworkarDdosProtectionPlanId) ? true : false)
    ddosProtectionPlan: (!empty(parSpokeNetworkarDdosProtectionPlanId) ? true : false) ? {
      id: parSpokeNetworkarDdosProtectionPlanId
    } : null
    dhcpOptions: (!empty(parDnsServerIps.value) ? true : false) ? {
      dnsServers: parDnsServerIps.value
    } : null
    subnets: parmSubnetConfigurations
  }
}


// // Create a virtual network resource lock if parGlobalResourceLock.value.kind != 'None' or if parSpokeNetworkLock.value.kind != 'None'
// resource resSpokeVirtualNetworkLock 'Microsoft.Authorization/locks@2020-05-01' = if (spokeNetwork.parSpokeNetworkLock.value.kind != 'None' || spokeNetwork.parGlobalResourceLock.value.kind != 'None') {
//   scope: resSpokeVirtualNetwork
//   name: spokeNetwork.parSpokeNetworkLock.value.?name ?? '${resSpokeVirtualNetwork.name}-lock'
//   properties: {
//     level: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.kind : spokeNetwork.parSpokeNetworkLock.value.kind
//     notes: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.?notes : spokeNetwork.parSpokeNetworkLock.value.?notes
//   }
// }

resource resSpokeVirtualNetworkLock 'Microsoft.Authorization/locks@2020-05-01' = if (parSpokeNetworkLock.value.kind != 'None' || parGlobalResourceLock.value.kind != 'None') {
  scope: resSpokeVirtualNetwork
  name: parSpokeNetworkLock.value.?name ?? '${resSpokeVirtualNetwork.name}-lock'
  properties: {
    level: (parGlobalResourceLock.value.kind != 'None') ? parGlobalResourceLock.value.kind : parSpokeNetworkLock.value.kind
    notes: (parGlobalResourceLock.value.kind != 'None') ? parGlobalResourceLock.value.?notes : parSpokeNetworkLock.value.?notes
  }
}

resource resSpokeToHubRouteTable 'Microsoft.Network/routeTables@2023-02-01' = if (!empty(parNextHopIpAddress)) {
  name: parSpokeToHubRouteTableName
  location: parSpokeLocation
  tags: parTags
  properties: {
    routes: [
      {
        name: 'route-to-firewall'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: parNextHopIpAddress
        }
      }
    ]
    disableBgpRoutePropagation: parDisableBgpRoutePropagation
  }
}

// Create a Route Table if parAzFirewallEnabled is true and parGlobalResourceLock.value.kind != 'None' or if parHubRouteTableLock.value.kind != 'None'
resource resSpokeToHubRouteTableLock 'Microsoft.Authorization/locks@2020-05-01' = if (!empty(parNextHopIpAddress) && (parSpokeRouteTableLock.value.kind != 'None' || parGlobalResourceLock.value.kind != 'None')) {
  scope: resSpokeToHubRouteTable
  name: parSpokeRouteTableLock.value.?name ?? '${resSpokeToHubRouteTable.name}-lock'
  properties: {
    level: (parGlobalResourceLock.value.kind != 'None') ? parGlobalResourceLock.value.kind : parSpokeRouteTableLock.value.kind
    notes: (parGlobalResourceLock.value.kind != 'None') ? parGlobalResourceLock.value.?notes : parSpokeRouteTableLock.value.?notes
  }
}

output outSpokeVirtualNetworkName string = resSpokeVirtualNetwork.name
output outSpokeVirtualNetworkId string = resSpokeVirtualNetwork.id
output outSpokeVirtualNetworkRouteTableName string = resSpokeToHubRouteTable.name
output outSpokeVirtualNetworkRouteTableId string = resSpokeToHubRouteTable.id
