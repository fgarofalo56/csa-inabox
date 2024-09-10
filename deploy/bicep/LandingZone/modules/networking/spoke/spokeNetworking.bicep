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

@sys.description('Array to hold all vaules for spoke networking module.')
param spokeNetwork object

@sys.description('The Name of the Spoke Virtual Network.')
param parSpokeNetworkName string


@sys.description('Tags you would like to be applied to all resources in this module.')
param parTags object

// Customer Usage Attribution Id
var varCuaid = '0c428583-f2a1-4448-975c-2d6262fd193a'


//If Ddos parameter is true Ddos will be Enabled on the Virtual Network
//If Azure Firewall is enabled and Network DNS Proxy is enabled DNS will be configured to point to AzureFirewall
resource resSpokeVirtualNetwork 'Microsoft.Network/virtualNetworks@2023-02-01' = {
  name: parSpokeNetworkName
  location: spokeNetwork.parLocation
  tags: parTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        spokeNetwork.parSpokeNetworkAddressPrefix
      ]
    }
    enableDdosProtection: (!empty(spokeNetwork.pspokeNetworkarDdosProtectionPlanId) ? true : false)
    ddosProtectionPlan: (!empty(spokeNetwork.parDdosProtectionPlanId) ? true : false) ? {
      id: spokeNetwork.parDdosProtectionPlanId
    } : null
    dhcpOptions: (!empty(spokeNetwork.parDnsServerIps.value) ? true : false) ? {
      dnsServers: spokeNetwork.parDnsServerIps.value
    } : null
  }
}


// Create a virtual network resource lock if parGlobalResourceLock.value.kind != 'None' or if parSpokeNetworkLock.value.kind != 'None'
resource resSpokeVirtualNetworkLock 'Microsoft.Authorization/locks@2020-05-01' = if (spokeNetwork.parSpokeNetworkLock.value.kind != 'None' || spokeNetwork.parGlobalResourceLock.value.kind != 'None') {
  scope: resSpokeVirtualNetwork
  name: spokeNetwork.parSpokeNetworkLock.value.?name ?? '${resSpokeVirtualNetwork.name}-lock'
  properties: {
    level: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.kind : spokeNetwork.parSpokeNetworkLock.value.kind
    notes: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.?notes : spokeNetwork.parSpokeNetworkLock.value.?notes
  }
}

resource resSpokeToHubRouteTable 'Microsoft.Network/routeTables@2023-02-01' = if (!empty(spokeNetwork.parNextHopIpAddress)) {
  name: spokeNetwork.parSpokeToHubRouteTableName
  location: spokeNetwork.parLocation
  tags: parTags
  properties: {
    routes: [
      {
        name: 'udr-default-to-hub-nva'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: spokeNetwork.parNextHopIpAddress
        }
      }
    ]
    disableBgpRoutePropagation: spokeNetwork.parDisableBgpRoutePropagation
  }
}

// Create a Route Table if parAzFirewallEnabled is true and parGlobalResourceLock.value.kind != 'None' or if parHubRouteTableLock.value.kind != 'None'
resource resSpokeToHubRouteTableLock 'Microsoft.Authorization/locks@2020-05-01' = if (!empty(spokeNetwork.parNextHopIpAddress) && (spokeNetwork.parSpokeRouteTableLock.value.kind != 'None' || spokeNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resSpokeToHubRouteTable
  name: spokeNetwork.parSpokeRouteTableLock.value.?name ?? '${resSpokeToHubRouteTable.name}-lock'
  properties: {
    level: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.kind : spokeNetwork.parSpokeRouteTableLock.value.kind
    notes: (spokeNetwork.parGlobalResourceLock.value.kind != 'None') ? spokeNetwork.parGlobalResourceLock.value.?notes : spokeNetwork.parSpokeRouteTableLock.value.?notes
  }
}

// Optional Deployment for Customer Usage Attribution
module modCustomerUsageAttribution '../../../CRML/customerUsageAttribution/cuaIdResourceGroup.bicep' = if (!spokeNetwork.parTelemetryOptOut) {
  name: 'pid-${varCuaid}-${uniqueString(resourceGroup().id)}'
  params: {}
}

output outSpokeVirtualNetworkName string = resSpokeVirtualNetwork.name
output outSpokeVirtualNetworkId string = resSpokeVirtualNetwork.id
